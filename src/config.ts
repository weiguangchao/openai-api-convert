import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import type { BridgeOptions, CapabilityProfile, LogLevel, LoggingPolicy, StatePolicy, Upstream } from './types.ts';

type RecordValue = Record<string, unknown>;
const rootKeys = new Set(['apiKey', 'upstreams', 'statePath', 'port', 'firstEventTimeoutMs', 'outputIdleTimeoutMs', 'statePolicy', 'logging']);
const upstreamKeys = new Set(['baseUrl', 'apiKey', 'capabilities']);
const capabilityKeys = new Set(['functionTools', 'customTools', 'parallelToolCalls']);
const statePolicyKeys = new Set(['responseRetentionDays', 'attemptRetentionDays', 'cleanupThresholdBytes', 'hardLimitBytes']);
const loggingKeys = new Set(['level', 'path', 'retentionDays']);
const logLevels = new Set<LogLevel>(['debug', 'info', 'error']);

const object = (value: unknown, path: string): RecordValue => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be an object`);
  return value as RecordValue;
};

const rejectUnknown = (value: RecordValue, allowed: Set<string>, path: string) => {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${path}.${key} is not allowed`);
};

const requiredText = (value: unknown, path: string) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${path} must be a non-empty string`);
  return value;
};

const optionalPositiveInteger = (value: unknown, path: string) => {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${path} must be a positive integer`);
  return value;
};

const capabilities = (value: unknown, path: string): CapabilityProfile | undefined => {
  if (value === undefined) return undefined;
  const profile = object(value, path);
  rejectUnknown(profile, capabilityKeys, path);
  for (const [key, supported] of Object.entries(profile)) if (typeof supported !== 'boolean') throw new Error(`${path}.${key} must be a boolean`);
  return profile as CapabilityProfile;
};

const upstreams = (value: unknown): Upstream[] => {
  if (!Array.isArray(value) || value.length === 0) throw new Error('Configuration.upstreams must be a non-empty array');
  return value.map((entry, index) => {
    const path = `Configuration.upstreams[${index}]`;
    const upstream = object(entry, path);
    rejectUnknown(upstream, upstreamKeys, path);
    return {
      baseUrl: requiredText(upstream.baseUrl, `${path}.baseUrl`),
      apiKey: requiredText(upstream.apiKey, `${path}.apiKey`),
      capabilities: capabilities(upstream.capabilities, `${path}.capabilities`),
    };
  });
};

const statePolicy = (value: unknown): StatePolicy | undefined => {
  if (value === undefined) return undefined;
  const policy = object(value, 'Configuration.statePolicy');
  rejectUnknown(policy, statePolicyKeys, 'Configuration.statePolicy');
  return Object.fromEntries(Object.entries(policy).map(([key, number]) => [key, optionalPositiveInteger(number, `Configuration.statePolicy.${key}`)])) as StatePolicy;
};

const logging = (value: unknown, configDir: string, statePath: string): LoggingPolicy => {
  const policy = value === undefined ? {} : object(value, 'Configuration.logging');
  rejectUnknown(policy, loggingKeys, 'Configuration.logging');
  const level = policy.level === undefined ? 'info' : policy.level;
  if (typeof level !== 'string' || !logLevels.has(level as LogLevel)) throw new Error('Configuration.logging.level must be one of debug, info, error');
  const retentionDays = optionalPositiveInteger(policy.retentionDays, 'Configuration.logging.retentionDays') ?? 7;
  const configuredPath = policy.path === undefined ? join(dirname(statePath), 'logs') : requiredText(policy.path, 'Configuration.logging.path');
  const logPath = policy.path === undefined || isAbsolute(configuredPath) ? configuredPath : resolve(configDir, configuredPath);
  return { level: level as LogLevel, path: logPath, retentionDays };
};

export const loadBridgeConfiguration = async (path = resolve('config.yaml')): Promise<BridgeOptions> => {
  let source: string;
  try { source = await readFile(path, 'utf8'); }
  catch { throw new Error(`Bridge configuration cannot be read: ${path}`); }
  const document = parseDocument(source, { prettyErrors: false, uniqueKeys: true });
  if (document.errors.length) throw new Error(`Bridge configuration is invalid: ${document.errors[0].message}`);
  const configuration = object(document.toJS(), 'Configuration');
  rejectUnknown(configuration, rootKeys, 'Configuration');
  const port = configuration.port;
  if (port !== undefined && (typeof port !== 'number' || !Number.isSafeInteger(port) || port < 0 || port > 65_535)) throw new Error('Configuration.port must be an integer from 0 to 65535');
  const usesDefaultStatePath = configuration.statePath === undefined;
  const configuredStatePath = usesDefaultStatePath ? join(homedir(), '.openai-api-convert', 'response-bridge.db') : requiredText(configuration.statePath, 'Configuration.statePath');
  const statePath = isAbsolute(configuredStatePath) ? configuredStatePath : resolve(dirname(path), configuredStatePath);
  if (usesDefaultStatePath) await mkdir(dirname(statePath), { recursive: true });
  return {
    apiKey: requiredText(configuration.apiKey, 'Configuration.apiKey'),
    upstreams: upstreams(configuration.upstreams),
    statePath,
    port,
    firstEventTimeoutMs: optionalPositiveInteger(configuration.firstEventTimeoutMs, 'Configuration.firstEventTimeoutMs'),
    outputIdleTimeoutMs: optionalPositiveInteger(configuration.outputIdleTimeoutMs, 'Configuration.outputIdleTimeoutMs'),
    statePolicy: statePolicy(configuration.statePolicy),
    logging: logging(configuration.logging, dirname(path), statePath),
  };
};

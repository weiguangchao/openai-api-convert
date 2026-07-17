import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import type { BridgeOptions, CapabilityProfile, StatePolicy, Upstream } from './server.ts';

type RecordValue = Record<string, unknown>;
const rootKeys = new Set(['apiKey', 'upstreams', 'statePath', 'port', 'firstEventTimeoutMs', 'outputIdleTimeoutMs', 'statePolicy']);
const upstreamKeys = new Set(['baseUrl', 'apiKey', 'capabilities']);
const capabilityKeys = new Set(['functionTools', 'customTools', 'parallelToolCalls']);
const statePolicyKeys = new Set(['responseRetentionDays', 'attemptRetentionDays', 'cleanupThresholdBytes', 'hardLimitBytes']);

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
  const configuredStatePath = configuration.statePath === undefined ? './response-bridge.db' : requiredText(configuration.statePath, 'Configuration.statePath');
  return {
    apiKey: requiredText(configuration.apiKey, 'Configuration.apiKey'),
    upstreams: upstreams(configuration.upstreams),
    statePath: isAbsolute(configuredStatePath) ? configuredStatePath : resolve(dirname(path), configuredStatePath),
    port,
    firstEventTimeoutMs: optionalPositiveInteger(configuration.firstEventTimeoutMs, 'Configuration.firstEventTimeoutMs'),
    outputIdleTimeoutMs: optionalPositiveInteger(configuration.outputIdleTimeoutMs, 'Configuration.outputIdleTimeoutMs'),
    statePolicy: statePolicy(configuration.statePolicy),
  };
};

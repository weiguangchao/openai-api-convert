import { chmod, mkdir, stat, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { loadBridgeConfiguration } from './config.js';
import { startBridge } from './server.js';

export const CONFIGURATION_HOME = join(homedir(), '.openai-api-convert');
export const DEFAULT_CONFIGURATION_PATH = join(CONFIGURATION_HOME, 'config.yaml');

const template = `# Fill every empty value before starting the Bridge.\napiKey: \"\"\nupstreams:\n  - baseUrl: \"\"\n    apiKey: \"\"\n    capabilities:\n      functionTools: true\n      customTools: true\n      parallelToolCalls: true\nport: 8417\nfirstEventTimeoutMs: 30000\noutputIdleTimeoutMs: 60000\nstatePolicy:\n  responseRetentionDays: 30\n  attemptRetentionDays: 7\n  cleanupThresholdBytes: 8589934592\n  hardLimitBytes: 10737418240\nlogging:\n  level: info\n  retentionDays: 7\n`;

const isPosix = () => platform() !== 'win32';

const permission = async (path: string) => (await stat(path)).mode & 0o777;

const requireSecureConfiguration = async (path: string) => {
  if (!isPosix()) return;
  if ((await permission(path)) & 0o077) throw new Error(`Bridge configuration permissions are too broad: ${path}`);
};

const bootstrap = async (path: string, isDefaultPath: boolean) => {
  const directory = dirname(path);
  try {
    await stat(path);
    if (isDefaultPath && isPosix() && (await permission(directory)) & 0o077) {
      throw new Error(`Configuration Home permissions are too broad: ${directory}`);
    }
    await requireSecureConfiguration(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (isDefaultPath && isPosix()) await chmod(directory, 0o700);
  await writeFile(path, template, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  if (isPosix()) await chmod(path, 0o600);
  console.log(`Bridge configuration created: ${path}`);
  console.log('Fill required values, then run the command again.');
  return true;
};

export const parseStartArguments = (arguments_: string[]) => {
  if (arguments_.length === 1 && arguments_[0] === 'start') return DEFAULT_CONFIGURATION_PATH;
  if (arguments_.length === 3 && arguments_[0] === 'start' && arguments_[1] === '--config' && arguments_[2]) return resolve(arguments_[2]);
  throw new Error('Usage: openai-api-convert start [--config <path>]');
};

export const runCli = async (arguments_ = process.argv.slice(2)) => {
  const configPath = parseStartArguments(arguments_);
  if (await bootstrap(configPath, configPath === DEFAULT_CONFIGURATION_PATH)) return;
  const bridge = await startBridge(await loadBridgeConfiguration(configPath));
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    const timeout = setTimeout(() => process.exit(1), 30_000);
    timeout.unref();
    bridge.close().then(() => { process.exitCode = 0; }).catch(() => { process.exitCode = 1; }).finally(() => clearTimeout(timeout));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
};

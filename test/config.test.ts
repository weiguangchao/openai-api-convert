import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { loadBridgeConfiguration } from '../src/config.js';

const root = fileURLToPath(new URL('../..', import.meta.url));

const reservePort = async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
};

const startConfiguredBridge = async (configPath: string, env?: NodeJS.ProcessEnv) => {
  const child = spawn(process.execPath, [join(root, 'dist/src/index.js'), 'start', '--config', configPath], { cwd: dirname(configPath), env });
  let output = '';
  child.stdout.on('data', (chunk) => { output += String(chunk); });
  child.stderr.on('data', (chunk) => { output += String(chunk); });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Bridge did not start: ${output}`)), 3_000);
    const ready = () => {
      if (!output.includes('bridge_started')) return;
      clearTimeout(timeout);
      resolve();
    };
    child.stdout.on('data', ready);
    child.stderr.on('data', ready);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Bridge exited before startup (${code}): ${output}`));
    });
  });
  return { child, output: () => output };
};

const runRejectedConfiguration = async (source: string) => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-config-'));
  await writeFile(join(dir, 'config.yaml'), source);
  await chmod(join(dir, 'config.yaml'), 0o600);
  const child = spawn(process.execPath, [join(root, 'dist/src/index.js'), 'start', '--config', join(dir, 'config.yaml')], { cwd: dir });
  let output = '';
  child.stdout.on('data', (chunk) => { output += String(chunk); });
  child.stderr.on('data', (chunk) => { output += String(chunk); });
  try {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const [code] = await Promise.race([
      once(child, 'exit') as Promise<[number | null]>,
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error(`Bridge did not reject configuration: ${output}`)), 3_000); }),
    ]).finally(() => clearTimeout(timeout));
    return { code, output };
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      const [code] = await once(child, 'exit') as [number | null];
      assert.equal(code, 0);
    }
    await rm(dir, { recursive: true, force: true });
  }
};

test('CLI logs the actual loopback address and port after startup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-config-'));
  const port = await reservePort();
  await writeFile(join(dir, 'config.yaml'), [
    'apiKey: yaml-key',
    'upstreams:',
    '  - baseUrl: http://127.0.0.1:1',
    '    apiKey: upstream-key',
    `statePath: ${join(dir, 'state.db')}`,
    `port: ${port}`,
    '',
  ].join('\n'));
  await chmod(join(dir, 'config.yaml'), 0o600);
  const { child, output } = await startConfiguredBridge(join(dir, 'config.yaml'), {
      ...process.env,
      BRIDGE_API_KEY: 'environment-key',
      UPSTREAM_POOL: '[]',
      STATE_STORE_PATH: join(dir, 'environment.db'),
  });
  try {
    const startupLogs = output().split('\n')
      .filter((line) => line.includes('INFO [bridge] bridge_started'));
    assert.equal(startupLogs.length, 1);
    const [startupLog] = startupLogs;
    assert.match(startupLog, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z INFO \[bridge\] bridge_started\b/);
    assert.match(startupLog, /\baddress=127\.0\.0\.1\b/);
    assert.match(startupLog, new RegExp(`\\bport=${port}\\b`));
    const ready = await fetch(`http://127.0.0.1:${port}/readyz`, { headers: { authorization: 'Bearer yaml-key' } });
    assert.equal(ready.status, 503);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await once(child, 'exit');
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test('CLI creates the default State Store in the user home directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-config-'));
  const home = join(dir, 'home');
  const port = await reservePort();
  await mkdir(join(home, '.openai-api-convert'), { recursive: true, mode: 0o700 });
  const configPath = join(home, '.openai-api-convert', 'config.yaml');
  await writeFile(configPath, [
    'apiKey: yaml-key',
    'upstreams:',
    '  - baseUrl: http://127.0.0.1:1',
    '    apiKey: upstream-key',
    `port: ${port}`,
    '',
  ].join('\n'));
  await chmod(configPath, 0o600);
  const child = spawn(process.execPath, [join(root, 'dist/src/index.js'), 'start'], { cwd: dir, env: { ...process.env, HOME: home } });
  let output = '';
  child.stdout.on('data', (chunk) => { output += String(chunk); });
  child.stderr.on('data', (chunk) => { output += String(chunk); });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Bridge did not start: ${output}`)), 3_000);
    child.stdout.on('data', () => output.includes('bridge_started') && (clearTimeout(timeout), resolve()));
    child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`Bridge exited before startup (${code}): ${output}`)); });
  });
  try {
    assert.equal((await stat(join(home, '.openai-api-convert', 'response-bridge.db'))).isFile(), true);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await once(child, 'exit');
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test('CLI bootstraps the default configuration with owner-only permissions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-config-'));
  const home = join(dir, 'home');
  const child = spawn(process.execPath, [join(root, 'dist/src/index.js'), 'start'], { cwd: dir, env: { ...process.env, HOME: home } });
  let output = '';
  child.stdout.on('data', (chunk) => { output += String(chunk); });
  child.stderr.on('data', (chunk) => { output += String(chunk); });
  try {
    const [code] = await once(child, 'exit') as [number | null];
    const configPath = join(home, '.openai-api-convert', 'config.yaml');
    assert.equal(code, 0);
    assert.equal(output.includes('Fill required values'), true);
    assert.equal((await readFile(configPath, 'utf8')).includes('apiKey: ""'), true);
    if (process.platform !== 'win32') {
      assert.equal((await stat(configPath)).mode & 0o777, 0o600);
      assert.equal((await stat(dirname(configPath))).mode & 0o777, 0o700);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('CLI rejects missing, mistyped, and unknown YAML configuration before startup', async () => {
  for (const [source, message] of [
    ['upstreams: []\n', 'Configuration.apiKey'],
    ['apiKey: yaml-key\nupstreams:\n  - baseUrl: http://127.0.0.1:1\n    apiKey: upstream-key\nport: wrong\n', 'Configuration.port'],
    ['apiKey: yaml-key\nupstreams:\n  - baseUrl: http://127.0.0.1:1\n    apiKey: upstream-key\nextra: true\n', 'Configuration.extra'],
    ['apiKey: yaml-key\nupstreams:\n  - baseUrl: http://127.0.0.1:1\n    apiKey: upstream-key\n    wireApi: responses\n', 'Configuration.upstreams[0].wireApi'],
    ['apiKey: yaml-key\nupstreams:\n  - baseUrl: http://127.0.0.1:1\n    apiKey: upstream-key\n    wireApi: chat\n', 'Configuration.upstreams[0].wireApi'],
    ['apiKey: yaml-key\nupstreams:\n  - baseUrl: http://127.0.0.1:1\n    apiKey: upstream-key\n    capabilities:\n      webSearch: true\n', 'Configuration.upstreams[0].capabilities.webSearch'],
    ['apiKey: yaml-key\nupstreams:\n  - baseUrl: http://127.0.0.1:1\n    apiKey: upstream-key\n    thinking:\n      type: automatic\n', 'Configuration.upstreams[0].thinking.type'],
    ['apiKey: yaml-key\nupstreams:\n  - baseUrl: http://127.0.0.1:1\n    apiKey: upstream-key\nlogging:\n  level: verbose\n', 'Configuration.logging.level'],
  ]) {
    const rejected = await runRejectedConfiguration(source);
    assert.equal(rejected.code, 1);
    assert.equal(rejected.output.includes(message), true);
    assert.equal(rejected.output.includes('bridge_started'), false);
  }
});

test('loadBridgeConfiguration parses logging overrides for level, path, and retentionDays', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-config-'));
  const configPath = join(dir, 'config.yaml');
  const logPath = join(dir, 'custom-logs');
  try {
    await writeFile(configPath, [
      'apiKey: yaml-key',
      'upstreams:',
      '  - baseUrl: http://127.0.0.1:1',
      '    apiKey: upstream-key',
      `statePath: ${join(dir, 'state.db')}`,
      'logging:',
      '  level: debug',
      `  path: ${logPath}`,
      '  retentionDays: 14',
      '',
    ].join('\n'));
    const configuration = await loadBridgeConfiguration(configPath);
    assert.equal(configuration.port, 8417);
    assert.deepEqual(configuration.logging, {
      level: 'debug',
      path: logPath,
      retentionDays: 14,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadBridgeConfiguration parses an explicit upstream Thinking policy', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-config-'));
  const configPath = join(dir, 'config.yaml');
  try {
    await writeFile(configPath, [
      'apiKey: yaml-key',
      'upstreams:',
      '  - baseUrl: http://127.0.0.1:1',
      '    apiKey: upstream-key',
      '    thinking:',
      '      type: disabled',
      '',
    ].join('\n'));
    const configuration = await loadBridgeConfiguration(configPath);
    assert.deepEqual(configuration.upstreams[0].thinking, { type: 'disabled' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadBridgeConfiguration defaults logging to info, 7 days, and dirname(statePath)/logs/', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-config-'));
  const configPath = join(dir, 'config.yaml');
  const statePath = join(dir, 'state.db');
  try {
    await writeFile(configPath, [
      'apiKey: yaml-key',
      'upstreams:',
      '  - baseUrl: http://127.0.0.1:1',
      '    apiKey: upstream-key',
      `statePath: ${statePath}`,
      '',
    ].join('\n'));
    const configuration = await loadBridgeConfiguration(configPath);
    assert.deepEqual(configuration.logging, {
      level: 'info',
      path: join(dir, 'logs'),
      retentionDays: 7,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadBridgeConfiguration parses an explicit Release Preflight Model', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-config-'));
  const configPath = join(dir, 'config.yaml');
  try {
    await writeFile(configPath, [
      'apiKey: yaml-key',
      'upstreams:',
      '  - baseUrl: http://127.0.0.1:1',
      '    apiKey: upstream-key',
      `statePath: ${join(dir, 'state.db')}`,
      'releasePreflight:',
      '  model: smoke-model',
      '',
    ].join('\n'));
    const configuration = await loadBridgeConfiguration(configPath);
    assert.equal(configuration.releasePreflight?.model, 'smoke-model');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadBridgeConfiguration resolves relative logging.path against the config directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-config-'));
  const configPath = join(dir, 'config.yaml');
  try {
    await writeFile(configPath, [
      'apiKey: yaml-key',
      'upstreams:',
      '  - baseUrl: http://127.0.0.1:1',
      '    apiKey: upstream-key',
      `statePath: ${join(dir, 'state.db')}`,
      'logging:',
      '  path: relative-logs',
      '',
    ].join('\n'));
    const configuration = await loadBridgeConfiguration(configPath);
    assert.equal(configuration.logging?.path, resolve(dir, 'relative-logs'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadBridgeConfiguration rejects invalid logging configuration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-config-'));
  const configPath = join(dir, 'config.yaml');
  const base = [
    'apiKey: yaml-key',
    'upstreams:',
    '  - baseUrl: http://127.0.0.1:1',
    '    apiKey: upstream-key',
    `statePath: ${join(dir, 'state.db')}`,
  ].join('\n');
  try {
    for (const [loggingBlock, message] of [
      ['logging:\n  level: verbose\n', 'Configuration.logging.level'],
      ['logging:\n  retentionDays: 0\n', 'Configuration.logging.retentionDays'],
      ['logging:\n  path: ""\n', 'Configuration.logging.path'],
      ['logging:\n  extra: true\n', 'Configuration.logging.extra'],
    ] as const) {
      await writeFile(configPath, `${base}\n${loggingBlock}`);
      await assert.rejects(() => loadBridgeConfiguration(configPath), (error: Error) => {
        assert.equal(error.message.includes(message), true);
        return true;
      });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('CLI writes Traffic Log files to the configured logging.path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-config-'));
  const port = await reservePort();
  const logPath = join(dir, 'custom-logs');
  await writeFile(join(dir, 'config.yaml'), [
    'apiKey: yaml-key',
    'upstreams:',
    '  - baseUrl: http://127.0.0.1:1',
    '    apiKey: upstream-key',
    `statePath: ${join(dir, 'state.db')}`,
    `port: ${port}`,
    'logging:',
    `  path: ${logPath}`,
    '',
  ].join('\n'));
  await chmod(join(dir, 'config.yaml'), 0o600);
  const { child } = await startConfiguredBridge(join(dir, 'config.yaml'));
  try {
    const logFiles = await readdir(logPath);
    assert.ok(logFiles.length > 0, 'expected log files under configured logging.path');
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await once(child, 'exit');
    }
    await rm(dir, { recursive: true, force: true });
  }
});

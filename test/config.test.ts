import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));

const reservePort = async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
};

const startConfiguredBridge = async (dir: string, env?: NodeJS.ProcessEnv) => {
  const child = spawn(process.execPath, ['--experimental-strip-types', join(root, 'src/index.ts')], { cwd: dir, env });
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
  return child;
};

const runRejectedConfiguration = async (source: string) => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-config-'));
  await writeFile(join(dir, 'config.yaml'), source);
  const child = spawn(process.execPath, ['--experimental-strip-types', join(root, 'src/index.ts')], { cwd: dir });
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
      child.kill();
      await once(child, 'exit');
    }
    await rm(dir, { recursive: true, force: true });
  }
};

test('CLI starts from config.yaml and ignores legacy environment configuration', async () => {
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
  const child = await startConfiguredBridge(dir, {
      ...process.env,
      BRIDGE_API_KEY: 'environment-key',
      UPSTREAM_POOL: '[]',
      STATE_STORE_PATH: join(dir, 'environment.db'),
  });
  try {
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
  await writeFile(join(dir, 'config.yaml'), [
    'apiKey: yaml-key',
    'upstreams:',
    '  - baseUrl: http://127.0.0.1:1',
    '    apiKey: upstream-key',
    `port: ${port}`,
    '',
  ].join('\n'));
  const child = await startConfiguredBridge(dir, { ...process.env, HOME: home });
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

test('CLI rejects missing, mistyped, and unknown YAML configuration before startup', async () => {
  for (const [source, message] of [
    ['upstreams: []\n', 'Configuration.apiKey'],
    ['apiKey: yaml-key\nupstreams:\n  - baseUrl: http://127.0.0.1:1\n    apiKey: upstream-key\nport: wrong\n', 'Configuration.port'],
    ['apiKey: yaml-key\nupstreams:\n  - baseUrl: http://127.0.0.1:1\n    apiKey: upstream-key\nextra: true\n', 'Configuration.extra'],
  ]) {
    const rejected = await runRejectedConfiguration(source);
    assert.equal(rejected.code, 1);
    assert.equal(rejected.output.includes(message), true);
    assert.equal(rejected.output.includes('bridge_started'), false);
  }
});

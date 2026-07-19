import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { startBridge, type RunningBridge } from '../src/server.js';
import { namespaceToolAlias, toolSearchOutputContent } from '../src/adapter.js';
import type { Tool } from '../src/types.js';

const captureStdoutLines = () => {
  const lines: string[] = [];
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);
  const capture = (chunk: string | Uint8Array, encoding?: BufferEncoding) => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString(encoding ?? 'utf8');
    for (const line of text.split('\n')) if (line.trim()) lines.push(line);
  };
  process.stdout.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    capture(chunk, typeof encoding === 'string' ? encoding : undefined);
    return stdoutWrite(chunk, encoding as never, callback as never);
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    capture(chunk, typeof encoding === 'string' ? encoding : undefined);
    return stderrWrite(chunk, encoding as never, callback as never);
  }) as typeof process.stderr.write;
  return {
    lines,
    restore: () => {
      process.stdout.write = stdoutWrite;
      process.stderr.write = stderrWrite;
    },
  };
};

const logLinesFor = (lines: string[], event: string, level?: 'debug' | 'info' | 'error') => lines.filter((line) => line.includes(`[bridge] ${event}`)
  && (level === undefined || line.includes(` ${level.toUpperCase()} [bridge] `)));

const codexMixedTools = JSON.parse(
  await readFile(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/codex-0.144.5-mixed-tools.json'), 'utf8'),
) as unknown[];

const sseTypes = (body: string) => [...body.matchAll(/^data: (.+)$/gm)]
  .map((match) => JSON.parse(match[1]) as { type: string });

const startCompatibilityFixture = async () => {
  const requests: unknown[] = [];
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"object":"list","data":[]}');
      return;
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"choices":[{"delta":{"content":"Hello "}}]}\r\n\r\n');
    response.write('data: {"choices":[{"delta":{"content":"world"}}]}\r\n\r\n');
    response.end('data: [DONE]\r\n\r\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  return {
    requests,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
};

const startJsonFixture = async (completion: Record<string, unknown>) => {
  const requests: unknown[] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(completion));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  return {
    requests,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
};

const startIdempotencyFixture = async () => {
  const requests: unknown[] = [];
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"choices":[{"delta":{"content":"first "}}]}\r\n\r\n');
    await pending;
    response.write('data: {"choices":[{"delta":{"content":"second"}}]}\r\n\r\n');
    response.end('data: [DONE]\r\n\r\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  return {
    requests,
    release,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
};

const functionSingleStreams = [
  [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_weather","type":"function","function":{"name":"weather","arguments":"{\\\"city\\\":\\\""}}]}}]}\r\n\r\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"Paris\\\"}"}}]}}]}\r\n\r\n',
    'data: [DONE]\r\n\r\n',
  ],
  [
    'data: {"choices":[{"delta":{"content":"It is sunny."}}]}\r\n\r\n',
    'data: [DONE]\r\n\r\n',
  ],
];

const functionParallelStreams = [
  [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_weather","type":"function","function":{"name":"weather","arguments":"{\\\"city\\\":\\\"Paris\\\"}"}},{"index":1,"id":"call_time","type":"function","function":{"name":"time","arguments":"{\\\"zone\\\":\\\"UTC\\\"}"}}]}}]}\r\n\r\n',
    'data: [DONE]\r\n\r\n',
  ],
  [
    'data: {"choices":[{"delta":{"content":"Paris is sunny at noon."}}]}\r\n\r\n',
    'data: [DONE]\r\n\r\n',
  ],
];

const functionMixedStreams = [
  [
    'data: {"choices":[{"delta":{"content":"Checking. "}}]}\r\n\r\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_weather","type":"function","function":{"name":"weather","arguments":"{}"}}]}}]}\r\n\r\n',
    'data: [DONE]\r\n\r\n',
  ],
];

const functionOutOfOrderStreams = [
  [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_time","type":"function","function":{"name":"time","arguments":"{}"}}]}}]}\r\n\r\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_weather","type":"function","function":{"name":"weather","arguments":"{}"}}]}}]}\r\n\r\n',
    'data: [DONE]\r\n\r\n',
  ],
];

const startFunctionFixture = async (streams = functionSingleStreams) => {
  const requests: unknown[] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end((streams[requests.length - 1] ?? ['data: [DONE]\r\n\r\n']).join(''));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  return {
    requests,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
};

const supportedCapabilities = { functionTools: true, parallelToolCalls: true };

const startCustomFixture = async () => {
  const requests: unknown[] = [];
  const streams = [
    [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_shell","type":"function","function":{"name":"shell","arguments":"{\\"input\\":\\"ls\\"}"}}]}}]}\r\n\r\n',
      'data: [DONE]\r\n\r\n',
    ],
    [
      'data: {"choices":[{"delta":{"content":"done"}}]}\r\n\r\n',
      'data: [DONE]\r\n\r\n',
    ],
  ];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end((streams[requests.length - 1] ?? ['data: [DONE]\r\n\r\n']).join(''));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  return {
    requests,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
};

const startToolSearchFixture = async () => {
  const requests: unknown[] = [];
  const streams = [
    // Turn 1: the model discovers tools via the fixed tool_search function proxy.
    [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_ts","type":"function","function":{"name":"tool_search","arguments":"{}"}}]}}]}\r\n\r\n',
      'data: [DONE]\r\n\r\n',
    ],
    // Turn 2: the model calls a dynamically loaded function returned by tool search.
    [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_weather","type":"function","function":{"name":"get_weather","arguments":"{\\"city\\":\\"Paris\\"}"}}]}}]}\r\n\r\n',
      'data: [DONE]\r\n\r\n',
    ],
  ];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end((streams[requests.length - 1] ?? ['data: [DONE]\r\n\r\n']).join(''));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  return {
    requests,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
};

const startToolSearchNamespaceFixture = async () => {
  const requests: unknown[] = [];
  const streams = [
    // Turn 1: discover tools via tool_search.
    [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_ts","type":"function","function":{"name":"tool_search","arguments":"{}"}}]}}]}\r\n\r\n',
      'data: [DONE]\r\n\r\n',
    ],
    // Turn 2: call a dynamically loaded namespace function (aliased weather__get_forecast).
    [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_ns","type":"function","function":{"name":"weather__get_forecast","arguments":"{}"}}]}}]}\r\n\r\n',
      'data: [DONE]\r\n\r\n',
    ],
    // Turn 3: plain text reply.
    [
      'data: {"choices":[{"delta":{"content":"done"}}]}\r\n\r\n',
      'data: [DONE]\r\n\r\n',
    ],
  ];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end((streams[requests.length - 1] ?? ['data: [DONE]\r\n\r\n']).join(''));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  return {
    requests,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
};

const startRejectedFixture = async () => {
  const requests: unknown[] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end('{"error":"invalid tool"}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  return {
    requests,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
};

const startScriptedFixture = async (scripts: Array<{ status?: number; frames?: string[]; waitMs?: number; waitAfterFirstFrameMs?: number }>) => {
  const requests: unknown[] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    const script = scripts[requests.length - 1] ?? { status: 500 };
    response.writeHead(script.status ?? 200, { 'content-type': script.status && script.status >= 400 ? 'application/json' : 'text/event-stream' });
    if (script.waitMs) await new Promise((resolve) => setTimeout(resolve, script.waitMs));
    if (script.waitAfterFirstFrameMs && script.frames?.length) {
      response.write(script.frames[0]);
      await new Promise((resolve) => setTimeout(resolve, script.waitAfterFirstFrameMs));
      response.end(script.frames.slice(1).join(''));
      return;
    }
    response.end(script.frames?.join('') ?? '{"error":"unavailable"}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  return {
    requests,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
};

test('exposes public liveness and protected readiness', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startCompatibilityFixture();
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }],
      statePath: join(dir, 'state.db'),
    });
    const live = await fetch(`${bridge.url}/healthz`);
    assert.equal(live.status, 200);
    assert.deepEqual(await live.json(), { status: 'ok' });
    assert.equal((await fetch(`${bridge.url}/readyz`)).status, 401);
    const ready = await fetch(`${bridge.url}/readyz`, { headers: { authorization: 'Bearer bridge-key' } });
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { status: 'ready' });
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('reports not ready when every upstream probe fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [{ baseUrl: 'http://127.0.0.1:1', apiKey: 'upstream-key', capabilities: supportedCapabilities }],
      statePath: join(dir, 'state.db'),
    });
    const response = await fetch(`${bridge.url}/readyz`, { headers: { authorization: 'Bearer bridge-key' } });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { status: 'not_ready' });
  } finally {
    await bridge?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('returns not found for removed metrics and emits redacted single-line backend logs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startCompatibilityFixture();
  const captured = captureStdoutLines();
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }],
      statePath: join(dir, 'state.db'),
    });
    assert.equal((await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: 'secret invalid payload',
    })).status, 400);
    assert.equal((await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true, input: 'secret response input' }),
    })).status, 200);
    assert.equal((await fetch(`${bridge.url}/metrics`)).status, 404);
    assert.equal((await fetch(`${bridge.url}/metrics`, { headers: { authorization: 'Bearer bridge-key' } })).status, 404);
    const requestLog = captured.lines.find((line) => line.includes('http_request_completed'));
    assert(requestLog);
    assert.match(requestLog, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z (INFO|ERROR) \[bridge\] http_request_completed\b/);
    assert.match(requestLog, /\brequest_id=[^\s]+/);
    assert.match(requestLog, /\bduration_ms=\d+/);
    assert.equal(requestLog.includes('response_id=null'), false);
    assert.equal(requestLog.includes('error_code=null'), false);
    const serialized = captured.lines.join('\n');
    assert.equal(serialized.includes('secret invalid payload'), false);
    assert.equal(serialized.includes('secret response input'), false);
    assert.equal(serialized.includes('bridge-key'), false);
    assert.equal(serialized.includes('upstream-key'), false);
    assert.equal(serialized.includes(upstream.url), false);
  } finally {
    captured.restore();
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('writes human-readable Traffic Log files beside State Store without secrets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const statePath = join(dir, 'state.db');
  const upstream = await startCompatibilityFixture();
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }],
      statePath,
    });
    assert.equal((await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true, input: 'secret response input' }),
    })).status, 200);
    await bridge.close();
    bridge = undefined;
    const logFiles = await readdir(join(dir, 'logs'));
    assert.ok(logFiles.length > 0, 'expected log files under dirname(statePath)/logs/');
    const content = (await Promise.all(logFiles.map((name) => readFile(join(dir, 'logs', name), 'utf8')))).join('\n');
    assert.match(content, /^\d{4}-\d{2}-\d{2}T[^\n]+ (INFO|ERROR) \[bridge\] http_request_completed\b/m);
    assert.match(content, /^\d{4}-\d{2}-\d{2}T[^\n]+ INFO \[bridge\] state_store_cleanup\b/m);
    assert.equal(content.includes('\n  "'), false);
    assert.equal(content.includes('secret response input'), false);
    assert.equal(content.includes('bridge-key'), false);
    assert.equal(content.includes('upstream-key'), false);
    assert.equal(content.includes(upstream.url), false);
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Traffic Log records downstream inbound and upstream outbound at info level without secrets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startCompatibilityFixture();
  const captured = captureStdoutLines();
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }],
      statePath: join(dir, 'state.db'),
    });
    assert.equal((await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true, input: 'secret response input' }),
    })).status, 200);
    const inbound = logLinesFor(captured.lines, 'traffic_downstream_inbound', 'info').at(0);
    assert(inbound, 'expected info-level traffic_downstream_inbound log entry');
    assert.match(inbound, /\bmethod=POST\b/);
    assert.match(inbound, /\bpath=\/v1\/responses\b/);
    assert.equal(inbound.includes('body='), false);
    assert.equal(inbound.includes('headers='), false);
    assert.equal(inbound.includes('upstream_url='), false);
    const outbound = logLinesFor(captured.lines, 'traffic_upstream_outbound', 'info').at(0);
    assert(outbound, 'expected info-level traffic_upstream_outbound log entry');
    assert.match(outbound, /\battempt_index=1\b/);
    assert.equal(outbound.includes('body='), false);
    assert.equal(outbound.includes('headers='), false);
    assert.equal(outbound.includes('upstream_url='), false);
    const serialized = captured.lines.join('\n');
    assert.equal(serialized.includes('secret response input'), false);
    assert.equal(serialized.includes('bridge-key'), false);
    assert.equal(serialized.includes('upstream-key'), false);
    assert.equal(serialized.includes(upstream.url), false);
  } finally {
    captured.restore();
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('logs the actual loopback endpoint after binding a dynamic port', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startCompatibilityFixture();
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }],
      statePath: join(dir, 'state.db'),
      port: 0,
    });
    const port = Number(new URL(bridge.url).port);
    await bridge.close();
    bridge = undefined;
    const logFiles = await readdir(join(dir, 'logs'));
    const content = (await Promise.all(logFiles.map((name) => readFile(join(dir, 'logs', name), 'utf8')))).join('\n');
    assert.match(content, /INFO \[bridge\] bridge_started\b/);
    assert.match(content, /\baddress=127\.0\.0\.1\b/);
    assert.match(content, new RegExp(`\\bport=${port}\\b`));
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Traffic Log at debug level records body and upstream URL with redacted secrets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startCompatibilityFixture();
  const captured = captureStdoutLines();
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }],
      statePath: join(dir, 'state.db'),
      logging: { level: 'debug' },
    });
    assert.equal((await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true, input: 'visible response input' }),
    })).status, 200);
    const inboundDebug = logLinesFor(captured.lines, 'traffic_downstream_inbound', 'debug').at(0);
    assert(inboundDebug, 'expected debug-level traffic_downstream_inbound');
    assert.match(inboundDebug, /body="\{\\"stream\\":true,\\"input\\":\\"visible response input\\"\}"/);
    assert.match(inboundDebug, /headers=\{.*"authorization":"\[REDACTED\]".*\}/);
    const outboundDebug = logLinesFor(captured.lines, 'traffic_upstream_outbound', 'debug').at(0);
    assert(outboundDebug, 'expected debug-level traffic_upstream_outbound');
    assert.equal(outboundDebug.includes(`upstream_url=${upstream.url}/v1/chat/completions`), true);
    assert.match(outboundDebug, /body="\{.*visible response input.*\}"/);
    assert.match(outboundDebug, /headers=\{.*"authorization":"\[REDACTED\]".*\}/);
    const serialized = captured.lines.join('\n');
    assert.equal(serialized.includes('bridge-key'), false);
    assert.equal(serialized.includes('upstream-key'), false);
  } finally {
    captured.restore();
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Traffic Log records upstream inbound and downstream outbound at info level without secrets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startCompatibilityFixture();
  const captured = captureStdoutLines();
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }],
      statePath: join(dir, 'state.db'),
    });
    assert.equal((await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true, input: 'secret response input' }),
    })).status, 200);
    const upstreamInbound = logLinesFor(captured.lines, 'traffic_upstream_inbound', 'info');
    assert.ok(upstreamInbound.length > 0, 'expected info-level traffic_upstream_inbound log entries');
    for (const line of upstreamInbound) {
      assert.match(line, /\bstatus=\d+\b/);
      assert.equal(line.includes('body='), false);
      assert.equal(line.includes('headers='), false);
    }
    const downstreamOutbound = logLinesFor(captured.lines, 'traffic_downstream_outbound', 'info');
    assert.ok(downstreamOutbound.length > 0, 'expected info-level traffic_downstream_outbound log entries');
    for (const line of downstreamOutbound) {
      assert.match(line, /\bevent_type=[^\s]+/);
      assert.equal(line.includes('sse_event='), false);
    }
    const serialized = captured.lines.join('\n');
    assert.equal(serialized.includes('secret response input'), false);
    assert.equal(serialized.includes('bridge-key'), false);
    assert.equal(serialized.includes('upstream-key'), false);
    assert.equal(serialized.includes(upstream.url), false);
  } finally {
    captured.restore();
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Traffic Log at debug level records upstream SSE chunks and downstream events with redacted secrets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startCompatibilityFixture();
  const captured = captureStdoutLines();
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }],
      statePath: join(dir, 'state.db'),
      logging: { level: 'debug' },
    });
    assert.equal((await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true, input: 'visible response input' }),
    })).status, 200);
    const upstreamDebug = logLinesFor(captured.lines, 'traffic_upstream_inbound', 'debug');
    assert.ok(upstreamDebug.length > 0, 'expected debug-level traffic_upstream_inbound entries');
    const upstreamHeadersEntry = upstreamDebug.find((line) => line.includes('headers='));
    assert(upstreamHeadersEntry, 'expected upstream inbound debug entry with headers');
    assert.match(upstreamHeadersEntry, /headers=\{.*"content-type":"[^"]+".*\}/);
    const upstreamBodyEntries = upstreamDebug.filter((line) => line.includes('body='));
    assert.ok(upstreamBodyEntries.length >= 3, 'expected upstream inbound debug entries with SSE body chunks');
    assert.ok(upstreamBodyEntries.some((line) => line.includes('Hello ')));
    assert.ok(upstreamBodyEntries.some((line) => line.includes('world')));
    assert.ok(upstreamBodyEntries.some((line) => line.includes('body="[DONE]"')));
    const downstreamDebug = logLinesFor(captured.lines, 'traffic_downstream_outbound', 'debug');
    assert.ok(downstreamDebug.length >= 5, 'expected at least 5 debug-level traffic_downstream_outbound entries');
    assert.ok(downstreamDebug.some((line) => line.includes('event_type=response.created')));
    assert.ok(downstreamDebug.some((line) => line.includes('event_type=response.output_text.delta')));
    assert.ok(downstreamDebug.some((line) => line.includes('event_type=response.output_item.done')));
    assert.ok(downstreamDebug.some((line) => line.includes('event_type=response.completed')));
    for (const line of downstreamDebug) {
      assert.match(line, /\bevent_type=[^\s]+/);
      assert.equal(line.includes('sse_event={'), true);
    }
    const serialized = captured.lines.join('\n');
    assert.equal(serialized.includes('bridge-key'), false);
    assert.equal(serialized.includes('upstream-key'), false);
  } finally {
    captured.restore();
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Traffic Log records every Attempt during failover', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const primary = await startScriptedFixture([
    { frames: functionSingleStreams[0] },
    { status: 429 },
  ]);
  const fallback = await startCompatibilityFixture();
  const captured = captureStdoutLines();
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [
        { baseUrl: primary.url, apiKey: 'upstream-key', capabilities: supportedCapabilities },
        { baseUrl: fallback.url, apiKey: 'upstream-key', capabilities: supportedCapabilities },
      ],
      statePath: join(dir, 'state.db'),
    });
    const headers = { authorization: 'Bearer bridge-key', 'content-type': 'application/json' };
    const first = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers,
      body: JSON.stringify({ stream: true, input: 'Weather?', tools: [{ type: 'function', name: 'weather' }] }),
    });
    const firstEvents = sseTypes(await first.text());
    const previousResponseId = (firstEvents.find(({ type }) => type === 'response.completed') as unknown as { response: { id: string } }).response.id;
    const second = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers,
      body: JSON.stringify({
        stream: true, previous_response_id: previousResponseId,
        input: [{ type: 'function_call_output', call_id: 'call_weather', output: 'sunny' }],
      }),
    });
    assert.equal((await second.text()).length > 0, true);
    const outbound = logLinesFor(captured.lines, 'traffic_upstream_outbound');
    const inbound = logLinesFor(captured.lines, 'traffic_upstream_inbound');
    assert.equal(outbound.length, 3, 'expected 3 outbound entries (1 + 2 failover)');
    assert.equal(inbound.length, 3, 'expected 3 inbound entries (1 + 2 failover)');
    assert.deepEqual(outbound.map((line) => /\battempt_index=(\d+)\b/.exec(line)?.[1]), ['1', '1', '2']);
    assert.deepEqual(inbound.map((line) => /\bstatus=(\d+)\b/.exec(line)?.[1]), ['200', '429', '200']);
    const serialized = captured.lines.join('\n');
    assert.equal(serialized.includes('bridge-key'), false);
    assert.equal(serialized.includes('upstream-key'), false);
  } finally {
    captured.restore();
    await bridge?.close();
    await primary.close();
    await fallback.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('writes human-readable Traffic Log SSE events per line at debug level', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startCompatibilityFixture();
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }],
      statePath: join(dir, 'state.db'),
      logging: { level: 'debug' },
    });
    assert.equal((await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true, input: 'visible response input' }),
    })).status, 200);
    await bridge.close();
    bridge = undefined;
    const logFiles = await readdir(join(dir, 'logs'));
    const content = (await Promise.all(logFiles.map((name) => readFile(join(dir, 'logs', name), 'utf8')))).join('\n');
    assert.match(content, /traffic_upstream_inbound/);
    assert.match(content, /traffic_downstream_outbound/);
    assert.match(content, /\bbody=/);
    assert.match(content, /\bsse_event=\{/);
    assert.match(content, /\bevent_type=/);
    assert.equal(content.includes('\n  "'), false);
    assert.equal(content.includes('bridge-key'), false);
    assert.equal(content.includes('upstream-key'), false);
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('rejects invalid startup configuration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  try {
    await assert.rejects(() => startBridge({ apiKey: '', upstreams: [], statePath: join(dir, 'state.db') }), /API key/);
    await assert.rejects(() => startBridge({ apiKey: 'bridge-key', upstreams: [], statePath: join(dir, 'state.db') }), /Upstream Pool/);
    await assert.rejects(() => startBridge({
      apiKey: 'bridge-key',
      upstreams: [{ baseUrl: 'http://127.0.0.1:1', apiKey: 'upstream-key', capabilities: supportedCapabilities }],
      statePath: dir,
    }), /State Store/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('State Store startup cleanup removes only expired terminal Response Chains and logs safe cleanup data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const statePath = join(dir, 'state.db');
  const upstream = await startCompatibilityFixture();
  const captured = captureStdoutLines();
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }],
      statePath,
    });
    const headers = { authorization: 'Bearer bridge-key', 'content-type': 'application/json' };
    const first = sseTypes(await (await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers, body: JSON.stringify({ stream: true, input: 'first retained input' }),
    })).text());
    const responseId = (first[0] as unknown as { response: { id: string } }).response.id;
    await (await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers, body: JSON.stringify({ stream: true, input: 'second retained input', previous_response_id: responseId }),
    })).text();
    await bridge.close();
    bridge = undefined;

    const database = new DatabaseSync(statePath);
    database.exec(`
      UPDATE responses SET terminal_at = 0;
      UPDATE attempts SET created_at = 0;
      INSERT INTO responses (id, status, model, input_json, tools_json, parallel_tool_calls, context_complete, output_text, created_at)
      VALUES ('resp_active', 'in_progress', 'gpt-test', '[]', '[]', 0, 1, '', 0);
      INSERT INTO attempts (response_id, created_at) VALUES ('resp_active', 0);
    `);
    database.close();

    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }],
      statePath,
      statePolicy: { cleanupThresholdBytes: 1_000_000, hardLimitBytes: 2_000_000, responseRetentionDays: 30, attemptRetentionDays: 7 },
    });
    assert.deepEqual(bridge.state.responses(), [
      { status: 'completed', outputText: 'Hello world' },
      { status: 'completed', outputText: 'Hello world' },
      { status: 'in_progress', outputText: '' },
    ]);
    assert.deepEqual(bridge.state.attempts(), [{ responseId: 'resp_active' }]);
    await bridge.close();

    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }],
      statePath,
      statePolicy: { cleanupThresholdBytes: 1, hardLimitBytes: 1_000_000, responseRetentionDays: 30, attemptRetentionDays: 7 },
    });
    assert.deepEqual(bridge.state.responses(), [{ status: 'in_progress', outputText: '' }]);
    assert.deepEqual(bridge.state.events(), []);
    assert.deepEqual(bridge.state.attempts(), [{ responseId: 'resp_active' }]);
    const cleanupLog = logLinesFor(captured.lines, 'state_store_cleanup')
      .find((line) => line.includes('deleted_chains=1'));
    assert(cleanupLog);
    assert.match(cleanupLog, /\bstarted_at=\d+\b/);
    assert.match(cleanupLog, /\bended_at=\d+\b/);
    assert.match(cleanupLog, /\breclaimed_bytes=\d+\b/);
    const serialized = captured.lines.join('\n');
    assert.equal(serialized.includes('retained input'), false);
    assert.equal(serialized.includes('bridge-key'), false);
  } finally {
    captured.restore();
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('State Store rejects a new Response before writes at the hard capacity limit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const statePath = join(dir, 'state.db');
  const upstream = await startCompatibilityFixture();
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }],
      statePath,
      statePolicy: { cleanupThresholdBytes: 1, hardLimitBytes: 2, responseRetentionDays: 30, attemptRetentionDays: 7 },
    });
    const response = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true, input: 'must not be stored' }),
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: { message: 'State Store capacity is exhausted', type: 'invalid_request_error', param: null, code: 'state_store_capacity_exceeded' },
    });
    assert.deepEqual(bridge.state.responses(), []);
    assert.deepEqual(bridge.state.attempts(), []);
    assert.equal(upstream.requests.length, 0);
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('bridges a text stream into ordered Responses SSE', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startCompatibilityFixture();
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }],
      statePath: join(dir, 'state.db'),
    });
    const unauthorized = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', body: JSON.stringify({ stream: true, input: 'hello' }),
    });
    assert.equal(unauthorized.status, 401);

    const response = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-test', stream: true, input: 'hello' }),
    });
    assert.equal(response.status, 200);
    const body = await response.text();
    const events = sseTypes(body);
    assert.deepEqual(events.map(({ type }) => type), [
      'response.created', 'response.in_progress', 'response.output_item.added', 'response.output_text.delta', 'response.output_text.delta',
      'response.output_item.done', 'response.completed',
    ]);
    assert.equal(body.includes('chat.completion.chunk'), false);
    assert.equal(body.includes('[DONE]'), false);
    assert.deepEqual(upstream.requests, [{
      model: 'gpt-test', stream: true, stream_options: { include_usage: true },
      messages: [{ role: 'user', content: 'hello' }],
    }]);
    assert.deepEqual(bridge.state.events().map((event) => event.sequence), [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(bridge.state.responses(), [{ status: 'completed', outputText: 'Hello world' }]);
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('bridges structured non-stream Responses input into a persisted JSON Response', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startJsonFixture({
    id: 'chatcmpl_upstream', model: 'o3',
    choices: [{ message: { role: 'assistant', content: 'Done.' }, finish_reason: 'stop' }],
  });
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }],
      statePath: join(dir, 'state.db'),
    });
    const headers = { authorization: 'Bearer bridge-key', 'content-type': 'application/json', 'idempotency-key': 'plain-json' };
    const payload = {
      model: 'o3', instructions: 'Follow instructions.', max_output_tokens: 42,
      temperature: 0.2, top_p: 0.8,
      input: [
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Developer policy.' }] },
        { type: 'message', role: 'system', content: [{ type: 'input_text', text: 'System policy.' }] },
        {
          type: 'message', role: 'user', content: [
            { type: 'input_text', text: 'Inspect these.' },
            { type: 'input_image', image_url: 'https://example.test/image.png', detail: 'low' },
            { type: 'input_file', filename: 'note.txt', file_data: 'data:text/plain;base64,bm90ZQ==' },
            { type: 'input_audio', input_audio: { data: 'YXVkaW8=', format: 'wav' } },
          ],
        },
        { id: 'external-history-id', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Prior answer.' }, { type: 'refusal', refusal: 'No secrets.' }] },
      ],
    };
    const first = await fetch(`${bridge.url}/v1/responses`, { method: 'POST', headers, body: JSON.stringify(payload) });
    assert.equal(first.status, 200);
    const firstBody = await first.json() as { id: string; object: string; status: string; model: string; output: unknown[] };
    assert.match(firstBody.id, /^resp_/);
    assert.deepEqual({ ...firstBody, id: '<local-response-id>' }, {
      id: '<local-response-id>', object: 'response', status: 'completed', model: 'o3',
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
      output: [{
        id: `msg_${firstBody.id}`, type: 'message', status: 'completed', role: 'assistant',
        content: [{ type: 'output_text', text: 'Done.' }],
      }],
    });
    const replay = await fetch(`${bridge.url}/v1/responses`, { method: 'POST', headers, body: JSON.stringify(payload) });
    assert.deepEqual(await replay.json(), firstBody);
    const changedControl = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers, body: JSON.stringify({ ...payload, temperature: 0.7 }),
    });
    assert.equal(changedControl.status, 409);
    assert.equal((await changedControl.json() as { error: { code: string } }).error.code, 'idempotency_key_conflict');
    assert.deepEqual(upstream.requests, [{
      model: 'o3', stream: false, max_completion_tokens: 42, temperature: 0.2, top_p: 0.8,
      messages: [
        { role: 'system', content: 'Follow instructions.\nDeveloper policy.\nSystem policy.' },
        {
          role: 'user', content: [
            { type: 'text', text: 'Inspect these.' },
            { type: 'image_url', image_url: { url: 'https://example.test/image.png', detail: 'low' } },
            { type: 'file', file: { filename: 'note.txt', file_data: 'data:text/plain;base64,bm90ZQ==' } },
            { type: 'input_audio', input_audio: { data: 'YXVkaW8=', format: 'wav' } },
          ],
        },
        { role: 'assistant', content: [{ type: 'text', text: 'Prior answer.' }, { type: 'refusal', refusal: 'No secrets.' }] },
      ],
    }]);
    assert.deepEqual(bridge.state.responses(), [{ status: 'completed', outputText: 'Done.' }]);
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('rejects an unknown structured input part without contacting the upstream', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startCompatibilityFixture();
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }],
      statePath: join(dir, 'state.db'),
    });
    const response = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({ stream: false, input: [{ type: 'message', role: 'user', content: [{ type: 'input_video', video_url: 'https://example.test/video.mp4' }] }] }),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json() as { error: { code: string } }).error.code, 'unsupported_input');
    assert.deepEqual(upstream.requests, []);
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('rejects a non-stream Chat JSON response without a first text choice', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startJsonFixture({ choices: [] });
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }],
      statePath: join(dir, 'state.db'),
    });
    const response = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({ stream: false, input: 'hello' }),
    });
    assert.equal(response.status, 502);
    assert.equal((await response.json() as { error: { code: string } }).error.code, 'upstream_invalid_json');
    assert.deepEqual(bridge.state.responses(), []);
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('persists an empty first Chat choice as an empty Responses message item', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startJsonFixture({ choices: [{ message: { role: 'assistant', content: '' } }] });
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }],
      statePath: join(dir, 'state.db'),
    });
    const response = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({ stream: false, input: 'hello' }),
    });
    const body = await response.json() as { output: Array<{ content: Array<{ text: string }> }> };
    assert.equal(response.status, 200);
    assert.deepEqual(body.output.map((item) => item.content[0]?.text), ['']);
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('function-single Compatibility Fixture continues a Response Chain', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startFunctionFixture();
  let bridge: RunningBridge | undefined;
  const tool = {
    type: 'function',
    name: 'weather',
    description: 'Gets weather',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  };
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }],
      statePath: join(dir, 'state.db'),
    });
    const first = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-test', stream: true, input: 'Weather in Paris?', tools: [tool] }),
    });
    const firstEvents = sseTypes(await first.text());
    const firstResponse = firstEvents.find(({ type }) => type === 'response.completed') as unknown as { response: { id: string } };
    const call = firstEvents.find(({ type }) => type === 'response.output_item.done') as unknown as { item: unknown };
    assert.deepEqual(call.item, {
      id: 'call_weather', type: 'function_call', status: 'completed', call_id: 'call_weather',
      name: 'weather', arguments: '{"city":"Paris"}',
    });

    const second = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-test', stream: true, previous_response_id: firstResponse.response.id,
        input: [{ type: 'function_call_output', call_id: 'call_weather', output: 'sunny' }],
      }),
    });
    const secondEvents = sseTypes(await second.text());
    assert.equal(secondEvents.at(-1)?.type, 'response.completed');
    assert.deepEqual(upstream.requests, [
      {
        model: 'gpt-test', stream: true, stream_options: { include_usage: true },
        messages: [{ role: 'user', content: 'Weather in Paris?' }],
        tools: [{ type: 'function', function: { name: 'weather', description: 'Gets weather', parameters: tool.parameters } }],
      },
      {
        model: 'gpt-test', stream: true, stream_options: { include_usage: true },
        messages: [
          { role: 'user', content: 'Weather in Paris?' },
          { role: 'assistant', tool_calls: [{ id: 'call_weather', type: 'function', function: { name: 'weather', arguments: '{"city":"Paris"}' } }] },
          { role: 'tool', tool_call_id: 'call_weather', content: 'sunny' },
        ],
        tools: [{ type: 'function', function: { name: 'weather', description: 'Gets weather', parameters: tool.parameters } }],
      },
    ]);
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('store:false Response Chain accepts echoed assistant input from prior turn', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startCompatibilityFixture();
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }],
      statePath: join(dir, 'state.db'),
    });
    const headers = { authorization: 'Bearer bridge-key', 'content-type': 'application/json' };
    const first = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers, body: JSON.stringify({ stream: true, store: false, input: 'hi' }),
    });
    const firstBody = await first.text();
    assert.equal(first.status, 200);
    const firstEvents = sseTypes(firstBody);
    const firstCompleted = firstEvents.find(({ type }) => type === 'response.completed') as unknown as {
      response: { id: string; output: Array<{ type: string; role?: string; content?: unknown }> };
    };
    const assistant = firstCompleted.response.output.find((item) => item.type === 'message');
    assert(assistant);

    const second = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        stream: true,
        store: false,
        previous_response_id: firstCompleted.response.id,
        input: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
          assistant,
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi again' }] },
        ],
      }),
    });
    const secondBody = await second.text();
    assert.equal(second.status, 200, secondBody);
    assert.equal(sseTypes(secondBody).at(-1)?.type, 'response.completed');
    assert.deepEqual(upstream.requests[1], {
      model: 'gpt-4.1', stream: true, stream_options: { include_usage: true },
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'Hello world' },
        { role: 'user', content: 'hi again' },
      ],
    });
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('function-parallel Compatibility Fixture preserves call order in a Response Chain', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startFunctionFixture(functionParallelStreams);
  let bridge: RunningBridge | undefined;
  const tools = [
    { type: 'function', name: 'weather', parameters: { type: 'object' } },
    { type: 'function', name: 'time', parameters: { type: 'object' } },
  ];
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key', upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }], statePath: join(dir, 'state.db'),
    });
    const first = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-test', stream: true, input: 'Weather and time?', tools, parallel_tool_calls: true }),
    });
    const firstEvents = sseTypes(await first.text());
    const firstResponse = firstEvents.find(({ type }) => type === 'response.completed') as unknown as { response: { id: string } };
    assert.deepEqual((firstEvents.filter(({ type }) => type === 'response.output_item.done') as unknown as Array<{ item: { call_id: string } }>)
      .map(({ item }) => item.call_id), ['call_weather', 'call_time']);

    const second = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-test', stream: true, previous_response_id: firstResponse.response.id,
        input: [
          { type: 'function_call_output', call_id: 'call_weather', output: 'sunny' },
          { type: 'function_call_output', call_id: 'call_time', output: 'noon' },
        ],
      }),
    });
    const events = sseTypes(await second.text());
    assert.equal(events.at(-1)?.type, 'response.completed');
    assert.deepEqual(upstream.requests, [
      {
        model: 'gpt-test', stream: true, stream_options: { include_usage: true }, parallel_tool_calls: true,
        messages: [{ role: 'user', content: 'Weather and time?' }],
        tools: [
          { type: 'function', function: { name: 'weather', parameters: { type: 'object' } } },
          { type: 'function', function: { name: 'time', parameters: { type: 'object' } } },
        ],
      },
      {
        model: 'gpt-test', stream: true, stream_options: { include_usage: true }, parallel_tool_calls: true,
        messages: [
          { role: 'user', content: 'Weather and time?' },
          { role: 'assistant', tool_calls: [
            { id: 'call_weather', type: 'function', function: { name: 'weather', arguments: '{"city":"Paris"}' } },
            { id: 'call_time', type: 'function', function: { name: 'time', arguments: '{"zone":"UTC"}' } },
          ] },
          { role: 'tool', tool_call_id: 'call_weather', content: 'sunny' },
          { role: 'tool', tool_call_id: 'call_time', content: 'noon' },
        ],
        tools: [
          { type: 'function', function: { name: 'weather', parameters: { type: 'object' } } },
          { type: 'function', function: { name: 'time', parameters: { type: 'object' } } },
        ],
      },
    ]);
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('keeps mixed text and Function Tool SSE events aligned to Output Item order', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startFunctionFixture(functionMixedStreams);
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key', upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }], statePath: join(dir, 'state.db'),
    });
    const response = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true, input: 'Check weather.', tools: [{ type: 'function', name: 'weather' }] }),
    });
    const events = sseTypes(await response.text()) as unknown as Array<{ type: string; output_index?: number; response?: { output: Array<{ type: string }> } }>;
    assert.deepEqual(events.filter((event) => event.type.includes('function_call_arguments')).map((event) => event.output_index), [1, 1]);
    assert.deepEqual(events.find((event) => event.type === 'response.completed')?.response?.output?.map((item) => item.type), ['message', 'function_call']);
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('orders out-of-order Function Tool chunks by their Chat call index', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startFunctionFixture(functionOutOfOrderStreams);
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key', upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }], statePath: join(dir, 'state.db'),
    });
    const response = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({
        stream: true, input: 'Check both.',
        tools: [{ type: 'function', name: 'weather' }, { type: 'function', name: 'time' }],
      }),
    });
    const events = sseTypes(await response.text()) as unknown as Array<{
      type: string; output_index?: number; item?: { call_id: string }; response?: { output: Array<{ call_id?: string }> };
    }>;
    assert.deepEqual(events.filter((event) => event.type === 'response.function_call_arguments.delta').map((event) => event.output_index), [1, 0]);
    assert.deepEqual(events.find((event) => event.type === 'response.completed')?.response?.output.map((item) => item.call_id), [
      'call_weather', 'call_time',
    ]);
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('rejects a missing Response Chain ancestor without creating a response', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startCompatibilityFixture();
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key', upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }], statePath: join(dir, 'state.db'),
    });
    const response = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({
        stream: true, previous_response_id: 'resp_missing',
        input: [{ type: 'function_call_output', call_id: 'call_missing', output: 'unavailable' }],
      }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: {
        message: 'Previous response was not found', type: 'invalid_request_error', param: null,
        code: 'previous_response_not_found',
      },
    });
    assert.deepEqual(upstream.requests, []);
    assert.deepEqual(bridge.state.responses(), []);
    const emptyPrevious = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true, previous_response_id: '', input: 'Continue.' }),
    });
    assert.equal(emptyPrevious.status, 400);
    assert.deepEqual(upstream.requests, []);
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('rejects a legacy Response Chain ancestor without saved context', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const statePath = join(dir, 'state.db');
  const legacy = new DatabaseSync(statePath);
  legacy.exec("CREATE TABLE responses (id TEXT PRIMARY KEY, status TEXT NOT NULL, output_text TEXT NOT NULL DEFAULT '') STRICT;");
  legacy.prepare('INSERT INTO responses (id, status) VALUES (?, ?)').run('resp_legacy', 'completed');
  legacy.close();
  const upstream = await startCompatibilityFixture();
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key', upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }], statePath,
    });
    const response = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true, previous_response_id: 'resp_legacy', input: 'Continue.' }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: {
        message: 'Previous response was not found', type: 'invalid_request_error', param: null,
        code: 'previous_response_not_found',
      },
    });
    assert.deepEqual(upstream.requests, []);
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('rejects an incomplete Response Chain ancestor', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const statePath = join(dir, 'state.db');
  const database = new DatabaseSync(statePath);
  database.exec("CREATE TABLE responses (id TEXT PRIMARY KEY, parent_id TEXT, status TEXT NOT NULL, model TEXT NOT NULL DEFAULT 'gpt-4.1', input_json TEXT NOT NULL DEFAULT '[]', tools_json TEXT NOT NULL DEFAULT '[]', context_complete INTEGER NOT NULL DEFAULT 1, output_text TEXT NOT NULL DEFAULT '') STRICT;");
  database.prepare('INSERT INTO responses (id, status) VALUES (?, ?)').run('resp_in_progress', 'in_progress');
  database.close();
  const upstream = await startCompatibilityFixture();
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key', upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }], statePath,
    });
    const response = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true, previous_response_id: 'resp_in_progress', input: 'Continue.' }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(upstream.requests, []);
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('rejects Function Tool output that is not associated with the Response Chain', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startFunctionFixture();
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key', upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }], statePath: join(dir, 'state.db'),
    });
    const first = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true, input: 'Weather?', tools: [{ type: 'function', name: 'weather' }] }),
    });
    const firstEvents = sseTypes(await first.text());
    const firstResponse = firstEvents.find(({ type }) => type === 'response.completed') as unknown as { response: { id: string } };
    const second = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({
        stream: true, previous_response_id: firstResponse.response.id,
        input: [{ type: 'function_call_output', call_id: 'call_unknown', output: 'sunny' }],
      }),
    });
    assert.equal(second.status, 400);
    assert.deepEqual(await second.json(), {
      error: {
        message: 'Tool call was not found', type: 'invalid_request_error', param: null,
        code: 'function_call_not_found',
      },
    });
    assert.equal(upstream.requests.length, 1);
    assert.deepEqual(bridge.state.responses(), [{ status: 'completed', outputText: '' }]);
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('rejects a delayed Function Tool result from an earlier Response', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startFunctionFixture();
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key', upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }], statePath: join(dir, 'state.db'),
    });
    const first = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true, input: 'Weather?', tools: [{ type: 'function', name: 'weather' }] }),
    });
    const firstEvents = sseTypes(await first.text());
    const firstResponse = firstEvents.find(({ type }) => type === 'response.completed') as unknown as { response: { id: string } };
    const second = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true, previous_response_id: firstResponse.response.id, input: 'Never mind.' }),
    });
    const secondEvents = sseTypes(await second.text());
    const secondResponse = secondEvents.find(({ type }) => type === 'response.completed') as unknown as { response: { id: string } };
    const delayed = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({
        stream: true, previous_response_id: secondResponse.response.id,
        input: [{ type: 'function_call_output', call_id: 'call_weather', output: 'sunny' }],
      }),
    });
    assert.equal(delayed.status, 400);
    assert.equal(upstream.requests.length, 2);
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('accepts nested and direct Function declarations and normalizes parameters for the Chat proxy', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startCompatibilityFixture();
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }],
      statePath: join(dir, 'state.db'),
    });
    const tools = [
      { type: 'function', name: 'direct', description: 'direct form', parameters: null },
      { type: 'function', function: { name: 'nested', parameters: { type: 'string' } } },
    ];
    const response = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-test', stream: true, input: 'hi', tools }),
    });
    assert.equal(response.status, 200);
    await response.text();
    assert.deepEqual((upstream.requests[0] as { tools: unknown[] }).tools, [
      { type: 'function', function: { name: 'direct', description: 'direct form', parameters: { type: 'object', properties: {} } } },
      { type: 'function', function: { name: 'nested', parameters: { type: 'object' } } },
    ]);
    const database = new DatabaseSync(join(dir, 'state.db'));
    const row = database.prepare('SELECT tools_json FROM responses ORDER BY created_at DESC LIMIT 1').get() as { tools_json: string };
    database.close();
    // Tool Context persists the original downstream definitions; only the Chat proxy normalized them.
    assert.deepEqual(JSON.parse(row.tools_json), [
      { type: 'function', name: 'direct', description: 'direct form', parameters: null },
      { type: 'function', name: 'nested', parameters: { type: 'string' } },
    ]);
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Function Tool Context is persisted and reused for continuation without re-deriving tools', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startFunctionFixture();
  let bridge: RunningBridge | undefined;
  const tool = { type: 'function', name: 'weather', parameters: null };
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }],
      statePath: join(dir, 'state.db'),
    });
    const first = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-test', stream: true, input: 'Weather?', tools: [tool] }),
    });
    const firstEvents = sseTypes(await first.text());
    const firstResponse = firstEvents.find(({ type }) => type === 'response.completed') as unknown as { response: { id: string } };
    assert.deepEqual((upstream.requests[0] as { tools: unknown[] }).tools, [
      { type: 'function', function: { name: 'weather', parameters: { type: 'object', properties: {} } } },
    ]);
    const database = new DatabaseSync(join(dir, 'state.db'));
    const row = database.prepare('SELECT tools_json FROM responses WHERE id = ?').get(firstResponse.response.id) as { tools_json: string };
    database.close();
    assert.deepEqual(JSON.parse(row.tools_json), [{ type: 'function', name: 'weather', parameters: null }]);

    const second = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-test', stream: true, previous_response_id: firstResponse.response.id,
        input: [{ type: 'function_call_output', call_id: 'call_weather', output: 'sunny' }],
      }),
    });
    const secondBody = await second.text();
    assert.equal(second.status, 200, secondBody);
    // Continuation sends no tools, so the Chat tools are rebuilt from the persisted Tool Context and re-normalized.
    assert.deepEqual((upstream.requests[1] as { tools: unknown[] }).tools, [
      { type: 'function', function: { name: 'weather', parameters: { type: 'object', properties: {} } } },
    ]);
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Inline Tool Replay accepts a paired call and output without previous_response_id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startCompatibilityFixture();
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }],
      statePath: join(dir, 'state.db'),
    });
    const response = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-test', stream: true,
        input: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Weather in Paris?' }] },
          { type: 'function_call', call_id: 'call_weather', name: 'weather', arguments: '{"city":"Paris"}' },
          { type: 'function_call_output', call_id: 'call_weather', output: 'sunny' },
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Thanks, what next?' }] },
        ],
        tools: [{ type: 'function', name: 'weather', parameters: { type: 'object' } }],
      }),
    });
    const body = await response.text();
    assert.equal(response.status, 200, body);
    assert.deepEqual((upstream.requests[0] as { messages: unknown[] }).messages, [
      { role: 'user', content: 'Weather in Paris?' },
      { role: 'assistant', tool_calls: [{ id: 'call_weather', type: 'function', function: { name: 'weather', arguments: '{"city":"Paris"}' } }] },
      { role: 'tool', tool_call_id: 'call_weather', content: 'sunny' },
      { role: 'user', content: 'Thanks, what next?' },
    ]);
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('rejects a Function Tool output without previous_response_id or a paired inline call', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startCompatibilityFixture();
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }],
      statePath: join(dir, 'state.db'),
    });
    const response = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-test', stream: true,
        input: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Weather?' }] },
          { type: 'function_call_output', call_id: 'call_weather', output: 'sunny' },
        ],
        tools: [{ type: 'function', name: 'weather', parameters: { type: 'object' } }],
      }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: {
        message: 'Tool output requires previous_response_id', type: 'invalid_request_error', param: null,
        code: 'missing_previous_response_id',
      },
    });
    assert.deepEqual(upstream.requests, []);
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('drops tool_choice and parallel_tool_calls when no Chat tools remain', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startCompatibilityFixture();
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }],
      statePath: join(dir, 'state.db'),
    });
    const response = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-test', stream: true, input: 'hi',
        tools: [], parallel_tool_calls: true, tool_choice: { type: 'function', name: 'weather' },
      }),
    });
    assert.equal(response.status, 200);
    await response.text();
    const request = upstream.requests[0] as { tools?: unknown; tool_choice?: unknown; parallel_tool_calls?: unknown };
    assert.equal(request.tools, undefined);
    assert.equal(request.tool_choice, undefined);
    assert.equal(request.parallel_tool_calls, undefined);
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Custom Tool proxies through a Chat function and round-trips with continuation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  // Custom Tools only require upstream Function Tool compatibility: a function-only upstream
  // (no native Custom support) is selected and receives a Function proxy.
  const upstream = await startCustomFixture();
  const shellProxy = {
    type: 'function',
    function: {
      name: 'shell',
      description: '{"type":"custom","name":"shell","description":"Runs shell"}',
      parameters: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] },
    },
  };
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: { functionTools: true } }],
      statePath: join(dir, 'state.db'),
    });
    const first = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true, input: 'List files.', tools: [{ type: 'custom', name: 'shell', description: 'Runs shell' }] }),
    });
    assert.equal(first.status, 200);
    const firstEvents = sseTypes(await first.text()) as unknown as Array<{ type: string; item?: { type: string; call_id: string; input: string }; response?: { id: string } }>;
    const call = firstEvents.find((event) => event.type === 'response.output_item.done')?.item;
    assert.deepEqual(call, { id: 'call_shell', type: 'custom_tool_call', status: 'completed', call_id: 'call_shell', name: 'shell', input: 'ls' });
    assert.deepEqual(upstream.requests[0], {
      model: 'gpt-4.1', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'List files.' }],
      tools: [shellProxy],
    });

    const responseId = firstEvents.find((event) => event.type === 'response.completed')?.response?.id;
    const second = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({
        stream: true, previous_response_id: responseId,
        input: [{ type: 'custom_tool_call_output', call_id: 'call_shell', output: 'file.txt' }],
      }),
    });
    assert.equal(second.status, 200);
    assert.equal(sseTypes(await second.text()).at(-1)?.type, 'response.completed');
    assert.deepEqual(upstream.requests[1], {
      model: 'gpt-4.1', stream: true, stream_options: { include_usage: true },
      messages: [
        { role: 'user', content: 'List files.' },
        { role: 'assistant', tool_calls: [{ id: 'call_shell', type: 'function', function: { name: 'shell', arguments: '{"input":"ls"}' } }] },
        { role: 'tool', tool_call_id: 'call_shell', content: 'file.txt' },
      ],
      tools: [shellProxy],
    });
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Custom Tool runs on a Function-only upstream without native Custom support', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startCompatibilityFixture();
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: { functionTools: true } }],
      statePath: join(dir, 'state.db'),
    });
    const response = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true, input: 'List files.', tools: [{ type: 'custom', name: 'shell' }] }),
    });
    assert.equal(response.status, 200);
    assert.equal(sseTypes(await response.text()).at(-1)?.type, 'response.completed');
    const request = upstream.requests[0] as { tools: Array<{ type: string; function?: { name: string } }> };
    assert.equal(request.tools.length, 1);
    assert.equal(request.tools[0].type, 'function');
    assert.equal(request.tools[0].function?.name, 'shell');
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

const loadedWeatherTool: Tool = { type: 'function', name: 'get_weather', description: 'Get weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } };
const toolSearchProxy = { type: 'function', function: { name: 'tool_search', description: 'Discover tools', parameters: { type: 'object', properties: {} } } };

test('Tool Search discovers, loads tools, and drives a subsequent dynamic tool call', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startToolSearchFixture();
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: { functionTools: true } }],
      statePath: join(dir, 'state.db'),
    });
    const headers = { authorization: 'Bearer bridge-key', 'content-type': 'application/json' };
    const first = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers,
      body: JSON.stringify({ stream: true, input: 'Find a weather tool.', tools: [{ type: 'tool_search', description: 'Discover tools' }] }),
    });
    assert.equal(first.status, 200);
    const firstEvents = sseTypes(await first.text()) as unknown as Array<{ type: string; item?: { type: string; call_id: string; arguments: string; execution: string } }>;
    assert.deepEqual(
      firstEvents.find((event) => event.type === 'response.output_item.done')?.item,
      { id: 'call_ts', type: 'tool_search_call', status: 'completed', call_id: 'call_ts', execution: 'client', arguments: '{}' },
    );
    assert.deepEqual(upstream.requests[0], {
      model: 'gpt-4.1', stream: true, stream_options: { include_usage: true },
      messages: [{ role: 'user', content: 'Find a weather tool.' }],
      tools: [toolSearchProxy],
    });

    const responseId = (firstEvents.find((event) => event.type === 'response.completed') as unknown as { response: { id: string } }).response.id;
    const second = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers,
      body: JSON.stringify({
        stream: true, previous_response_id: responseId,
        input: [{ type: 'tool_search_output', call_id: 'call_ts', tools: [loadedWeatherTool] }],
      }),
    });
    assert.equal(second.status, 200);
    const secondEvents = sseTypes(await second.text()) as unknown as Array<{ type: string; item?: { type: string; call_id: string; name: string; arguments: string } }>;
    assert.deepEqual(
      secondEvents.find((event) => event.type === 'response.output_item.done')?.item,
      { id: 'call_weather', type: 'function_call', status: 'completed', call_id: 'call_weather', name: 'get_weather', arguments: '{"city":"Paris"}' },
    );
    assert.deepEqual(upstream.requests[1], {
      model: 'gpt-4.1', stream: true, stream_options: { include_usage: true },
      messages: [
        { role: 'user', content: 'Find a weather tool.' },
        { role: 'assistant', tool_calls: [{ id: 'call_ts', type: 'function', function: { name: 'tool_search', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call_ts', content: toolSearchOutputContent([loadedWeatherTool]) },
      ],
      tools: [toolSearchProxy, { type: 'function', function: { name: 'get_weather', description: 'Get weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }],
    });
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Tool Search is proxied while Hosted Web Search still degrades alongside it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startCompatibilityFixture();
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }],
      statePath: join(dir, 'state.db'),
    });
    const response = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({
        stream: true, input: 'Find an example.',
        tools: [{ type: 'tool_search', description: 'Discover tools' }, { type: 'web_search' }],
        tool_choice: { type: 'web_search' },
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.text();
    const events = sseTypes(body);
    assert.equal(events.at(-1)?.type, 'response.completed');
    assert.equal(events.some(({ type }) => type === 'response.web_search_call.in_progress'), false);
    assert.equal(body.includes('url_citation'), false);
    const request = upstream.requests[0] as { messages: Array<{ role: string; content: string }>; tools: Array<{ type: string; function: { name: string } }>; tool_choice: unknown; parallel_tool_calls?: unknown };
    assert.deepEqual(request.tools, [toolSearchProxy]);
    assert.equal(request.tool_choice, 'auto');
    assert.equal(request.parallel_tool_calls, undefined);
    assert.equal(request.messages.some(({ role, content }) => role === 'system' && content.includes('web search is unavailable')), true);
    assert.deepEqual(request.messages.at(-1), { role: 'user', content: 'Find an example.' });
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Tool Search loaded Namespace tool continues across a Response Chain', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startToolSearchNamespaceFixture();
  const loadedNamespace: Tool = { type: 'namespace', name: 'weather', description: 'Weather tools', tools: [{ type: 'function', name: 'get_forecast' }] };
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: { functionTools: true, parallelToolCalls: true } }],
      statePath: join(dir, 'state.db'),
    });
    const headers = { authorization: 'Bearer bridge-key', 'content-type': 'application/json' };
    const first = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers,
      body: JSON.stringify({ stream: true, input: 'Find tools.', tools: [{ type: 'tool_search', description: 'Discover tools' }] }),
    });
    const firstId = (sseTypes(await first.text()).find(({ type }) => type === 'response.completed') as unknown as { response: { id: string } }).response.id;

    const second = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers,
      body: JSON.stringify({ stream: true, previous_response_id: firstId, input: [{ type: 'tool_search_output', call_id: 'call_ts', tools: [loadedNamespace] }] }),
    });
    const secondBody = await second.text();
    const secondId = (sseTypes(secondBody).find(({ type }) => type === 'response.completed') as unknown as { response: { id: string } }).response.id;
    const secondCall = (sseTypes(secondBody) as unknown as Array<{ type: string; item?: { type: string; name: string; namespace: string } }>)
      .find((event) => event.type === 'response.output_item.done')?.item;
    assert.deepEqual(secondCall, { id: 'call_ns', type: 'function_call', status: 'completed', call_id: 'call_ns', name: 'get_forecast', arguments: '{}', namespace: 'weather' });

    // The continuation rebuilds the predecessor's Tool Context from its persisted
    // tool_search_output input; without the loaded namespace alias this turn would fail.
    const third = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers,
      body: JSON.stringify({ stream: true, previous_response_id: secondId, input: [{ type: 'function_call_output', call_id: 'call_ns', output: 'sunny' }] }),
    });
    assert.equal(third.status, 200);
    assert.equal(sseTypes(await third.text()).at(-1)?.type, 'response.completed');
    const continuation = upstream.requests[2] as { messages: Array<{ role: string; content?: string; tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>; tool_call_id?: string }>; tools: Array<{ type: string; function: { name: string } }> };
    assert.deepEqual(continuation.tools.map((tool) => tool.function.name), ['tool_search', 'weather__get_forecast']);
    assert.deepEqual(continuation.messages, [
      { role: 'user', content: 'Find tools.' },
      { role: 'assistant', tool_calls: [{ id: 'call_ts', type: 'function', function: { name: 'tool_search', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_ts', content: toolSearchOutputContent([loadedNamespace]) },
      { role: 'assistant', tool_calls: [{ id: 'call_ns', type: 'function', function: { name: 'weather__get_forecast', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_ns', content: 'sunny' },
    ]);
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Hosted Web Search always degrades to Chat Completions without forging search results', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startCompatibilityFixture();
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }],
      statePath: join(dir, 'state.db'),
    });
    const response = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-test', stream: true, input: 'Find an example.',
        tools: [{ type: 'web_search', search_context_size: 'medium', user_location: { type: 'approximate', country: 'US' } }],
        tool_choice: { type: 'web_search' }, include: ['web_search_call.action.sources'],
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.text();
    const events = sseTypes(body);
    assert.equal(events.at(-1)?.type, 'response.completed');
    assert.equal(events.some(({ type }) => type === 'response.web_search_call.in_progress'), false);
    assert.equal(body.includes('url_citation'), false);
    assert.equal(upstream.requests.length, 1);
    const request = upstream.requests[0] as { messages: Array<{ role: string; content: string }>; tools?: unknown; tool_choice?: unknown; parallel_tool_calls?: unknown };
    assert.equal(request.tools, undefined);
    assert.equal(request.tool_choice, undefined);
    assert.equal(request.parallel_tool_calls, undefined);
    assert.equal(request.messages.some(({ role, content }) => role === 'system' && content.includes('web search is unavailable')), true);
    assert.deepEqual(request.messages.at(-1), { role: 'user', content: 'Find an example.' });
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Hosted Web Search Response Chain continues via Chat messages without upstream Response IDs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startCompatibilityFixture();
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }],
      statePath: join(dir, 'state.db'),
    });
    const headers = { authorization: 'Bearer bridge-key', 'content-type': 'application/json' };
    const first = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers, body: JSON.stringify({ stream: true, input: 'Find an example.', tools: [{ type: 'web_search' }] }),
    });
    const firstBody = await first.text();
    const responseId = (sseTypes(firstBody).find(({ type }) => type === 'response.completed') as unknown as { response: { id: string } }).response.id;
    await bridge.close();
    const state = new DatabaseSync(join(dir, 'state.db'));
    try {
      const columns = state.prepare('PRAGMA table_info(responses)').all() as Array<{ name: string }>;
      assert.equal(columns.some(({ name }) => name.startsWith('native_upstream_')), false);
    } finally {
      state.close();
    }
    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }],
      statePath: join(dir, 'state.db'),
    });
    const second = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers, body: JSON.stringify({ stream: true, previous_response_id: responseId, input: 'Continue.' }),
    });
    assert.equal(sseTypes(await second.text()).at(-1)?.type, 'response.completed');
    assert.equal(upstream.requests.length, 2);
    const continuation = upstream.requests[1] as { messages: Array<{ role: string; content?: string }>; previous_response_id?: unknown };
    assert.equal(continuation.previous_response_id, undefined);
    assert.equal(continuation.messages.some(({ role, content }) => role === 'user' && content === 'Find an example.'), true);
    assert.equal(continuation.messages.some(({ role, content }) => role === 'assistant' && content === 'Hello world'), true);
    assert.deepEqual(continuation.messages.at(-1), { role: 'user', content: 'Continue.' });
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('mixed tools with web_search select a Function-only upstream that proxies Custom Tools', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const functionOnly = await startCompatibilityFixture();
  const fullyCapable = await startCustomFixture();
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [
        { baseUrl: functionOnly.url, apiKey: 'upstream-key', capabilities: { functionTools: true } },
        { baseUrl: fullyCapable.url, apiKey: 'upstream-key', capabilities: supportedCapabilities },
      ],
      statePath: join(dir, 'state.db'),
    });
    const response = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({
        stream: true, input: 'Research and inspect the workspace.',
        tools: [
          { type: 'web_search' },
          { type: 'function', name: 'weather', description: 'Gets weather', parameters: { type: 'object' } },
          { type: 'custom', name: 'shell', description: 'Runs shell' },
        ],
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(sseTypes(await response.text()).at(-1)?.type, 'response.completed');
    // Custom Tools only need Function Tool compatibility, so the first Function-only upstream wins.
    assert.equal(functionOnly.requests.length, 1);
    assert.deepEqual(fullyCapable.requests, []);
    const request = functionOnly.requests[0] as { tools: unknown[] };
    assert.deepEqual(request.tools, [
      { type: 'function', function: { name: 'weather', description: 'Gets weather', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'shell', description: '{"type":"custom","name":"shell","description":"Runs shell"}', parameters: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] } } },
    ]);
  } finally {
    await bridge?.close();
    await functionOnly.close();
    await fullyCapable.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('mixed-tools reject when no upstream provides Function Tool compatibility', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startCompatibilityFixture();
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: { parallelToolCalls: true } }],
      statePath: join(dir, 'state.db'),
    });
    const response = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({
        stream: true, input: 'Research and inspect the workspace.',
        tools: [{ type: 'web_search' }, { type: 'function', name: 'weather' }, { type: 'custom', name: 'shell' }],
      }),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json() as { error: { code: string } }).error.code, 'unsupported_capabilities');
    assert.deepEqual(upstream.requests, []);
    assert.deepEqual(bridge.state.responses(), []);
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('maps Reasoning Effort to upstream reasoning_effort', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startCompatibilityFixture();
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }],
      statePath: join(dir, 'state.db'),
    });
    const response = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true, input: 'Hello', reasoning: { effort: 'high' } }),
    });
    assert.equal(response.status, 200);
    assert.equal(sseTypes(await response.text()).at(-1)?.type, 'response.completed');
    assert.equal((upstream.requests[0] as { reasoning_effort?: string }).reasoning_effort, 'high');
    const scalarResponse = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true, input: 'Hello', reasoning: 'max' }),
    });
    assert.equal(scalarResponse.status, 200);
    assert.equal(sseTypes(await scalarResponse.text()).at(-1)?.type, 'response.completed');
    assert.equal((upstream.requests[1] as { reasoning_effort?: string }).reasoning_effort, 'max');
    const ultraResponse = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true, input: 'Hello', reasoning: { effort: 'ultra' } }),
    });
    assert.equal(ultraResponse.status, 200);
    assert.equal(sseTypes(await ultraResponse.text()).at(-1)?.type, 'response.completed');
    assert.equal((upstream.requests[2] as { reasoning_effort?: string }).reasoning_effort, 'ultra');
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('omits upstream reasoning_effort when Reasoning Effort is absent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startCompatibilityFixture();
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }],
      statePath: join(dir, 'state.db'),
    });
    const withoutReasoning = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true, input: 'Hello' }),
    });
    assert.equal(withoutReasoning.status, 200);
    await withoutReasoning.text();
    const ignoredFields = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true, input: 'Hello', reasoning: { summary: 'auto', mode: 'pro' } }),
    });
    assert.equal(ignoredFields.status, 200);
    await ignoredFields.text();
    const nullReasoning = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true, input: 'Hello', reasoning: null }),
    });
    assert.equal(nullReasoning.status, 200);
    await nullReasoning.text();
    assert.equal('reasoning_effort' in (upstream.requests[0] as object), false);
    assert.equal('reasoning_effort' in (upstream.requests[1] as object), false);
    assert.equal('reasoning_effort' in (upstream.requests[2] as object), false);
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('rejects invalid Reasoning Effort before creating Response state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startCompatibilityFixture();
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }],
      statePath: join(dir, 'state.db'),
    });
    const headers = { authorization: 'Bearer bridge-key', 'content-type': 'application/json', 'idempotency-key': 'bad-effort' };
    const invalidScalar = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers, body: JSON.stringify({ stream: true, input: 'Hello', reasoning: 'invalid' }),
    });
    assert.equal(invalidScalar.status, 400);
    assert.equal((await invalidScalar.json() as { error: { code: string } }).error.code, 'invalid_reasoning');
    const badEffort = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers, body: JSON.stringify({ stream: true, input: 'Hello', reasoning: { effort: 'invalid' } }),
    });
    assert.equal(badEffort.status, 400);
    assert.equal((await badEffort.json() as { error: { code: string } }).error.code, 'invalid_reasoning');
    assert.deepEqual(upstream.requests, []);
    assert.deepEqual(bridge.state.responses(), []);
    assert.deepEqual(bridge.state.attempts(), []);
    await bridge.close();
    bridge = undefined;
    const state = new DatabaseSync(join(dir, 'state.db'));
    try {
      assert.deepEqual(state.prepare('SELECT key FROM idempotency_records').all(), []);
    } finally {
      state.close();
    }
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Idempotent Request conflicts when only Reasoning Effort differs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startCompatibilityFixture();
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }],
      statePath: join(dir, 'state.db'),
    });
    const headers = { authorization: 'Bearer bridge-key', 'content-type': 'application/json', 'idempotency-key': 'effort-once' };
    const first = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers, body: JSON.stringify({ stream: true, input: 'Hello', reasoning: { effort: 'low' } }),
    });
    assert.equal(first.status, 200);
    await first.text();
    const before = { events: bridge.state.events(), responses: bridge.state.responses(), attempts: bridge.state.attempts() };
    const conflict = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers, body: JSON.stringify({ stream: true, input: 'Hello', reasoning: { effort: 'high' } }),
    });
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), {
      error: { message: 'Idempotency-Key is already used for a different request', type: 'invalid_request_error', param: null, code: 'idempotency_key_conflict' },
    });
    assert.deepEqual({ events: bridge.state.events(), responses: bridge.state.responses(), attempts: bridge.state.attempts() }, before);
    assert.equal(upstream.requests.length, 1);
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Idempotent Request ignores non-effort reasoning fields in the digest', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startCompatibilityFixture();
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }],
      statePath: join(dir, 'state.db'),
    });
    const headers = { authorization: 'Bearer bridge-key', 'content-type': 'application/json', 'idempotency-key': 'ignore-fields' };
    const first = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers,
      body: JSON.stringify({ stream: true, input: 'Hello', reasoning: { effort: 'medium', summary: 'auto' } }),
    });
    assert.equal(first.status, 200);
    const firstBody = await first.text();
    const replay = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers,
      body: JSON.stringify({ stream: true, input: 'Hello', reasoning: { effort: 'medium', mode: 'pro' } }),
    });
    assert.equal(await replay.text(), firstBody);
    assert.equal(upstream.requests.length, 1);
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('forced web_search tool_choice degrades to auto', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startCompatibilityFixture();
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }],
      statePath: join(dir, 'state.db'),
    });
    const response = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({
        stream: true, input: 'Find an example.',
        tools: [{ type: 'web_search' }, { type: 'function', name: 'weather', description: 'Gets weather', parameters: { type: 'object' } }],
        tool_choice: { type: 'web_search' }, parallel_tool_calls: true,
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(sseTypes(await response.text()).at(-1)?.type, 'response.completed');
    assert.deepEqual(upstream.requests[0], {
      model: 'gpt-4.1', stream: true, stream_options: { include_usage: true },
      messages: [
        { role: 'system', content: 'Hosted web search is unavailable on this upstream. Do not claim you performed a live web search, cite live results, or invent search calls.' },
        { role: 'user', content: 'Find an example.' },
      ],
      tools: [{ type: 'function', function: { name: 'weather', description: 'Gets weather', parameters: { type: 'object' } } }],
      parallel_tool_calls: true,
      tool_choice: 'auto',
    });
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('forced web_search without Chat tools omits tool_choice and parallel_tool_calls', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startCompatibilityFixture();
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }],
      statePath: join(dir, 'state.db'),
    });
    const response = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({
        stream: true, input: 'Find an example.', tools: [{ type: 'web_search' }], tool_choice: { type: 'web_search' }, parallel_tool_calls: true,
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(sseTypes(await response.text()).at(-1)?.type, 'response.completed');
    assert.deepEqual(upstream.requests[0], {
      model: 'gpt-4.1', stream: true, stream_options: { include_usage: true },
      messages: [
        { role: 'system', content: 'Hosted web search is unavailable on this upstream. Do not claim you performed a live web search, cite live results, or invent search calls.' },
        { role: 'user', content: 'Find an example.' },
      ],
    });
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('mixed tools keep Function and Custom after web_search degradation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startCustomFixture();
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }],
      statePath: join(dir, 'state.db'),
    });
    const response = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({
        stream: true, input: 'Research and inspect the workspace.',
        tools: [
          { type: 'web_search' },
          { type: 'function', name: 'weather', description: 'Gets weather', parameters: { type: 'object' } },
          { type: 'custom', name: 'shell', description: 'Runs shell' },
        ],
      }),
    });
    assert.equal(response.status, 200);
    const events = sseTypes(await response.text());
    assert.equal(events.some(({ type }) => type === 'response.web_search_call.in_progress'), false);
    assert.deepEqual((events.find(({ type }) => type === 'response.output_item.done') as unknown as { item: unknown }).item, {
      id: 'call_shell', type: 'custom_tool_call', status: 'completed', call_id: 'call_shell', name: 'shell', input: 'ls',
    });
    const request = upstream.requests[0] as {
      messages: Array<{ role: string; content?: string }>;
      tools: unknown[];
    };
    assert.equal(request.messages[0]?.role, 'system');
    assert.equal(String(request.messages[0]?.content).includes('web search is unavailable'), true);
    assert.deepEqual(request.tools, [
      { type: 'function', function: { name: 'weather', description: 'Gets weather', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'shell', description: '{"type":"custom","name":"shell","description":"Runs shell"}', parameters: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] } } },
    ]);
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('web_search_preview is rejected before contacting an upstream', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startCompatibilityFixture();
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }],
      statePath: join(dir, 'state.db'),
    });
    const response = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true, input: 'Find an example.', tools: [{ type: 'web_search_preview' }] }),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json() as { error: { code: string } }).error.code, 'unsupported_tools');
    assert.deepEqual(upstream.requests, []);
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('parallel-incompatible Compatibility Fixture rejects before contacting an upstream', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startFunctionFixture();
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: { functionTools: true, parallelToolCalls: false } }],
      statePath: join(dir, 'state.db'),
    });
    const response = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true, input: 'Weather?', parallel_tool_calls: true, tools: [{ type: 'function', name: 'weather' }] }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: { message: 'No upstream supports the requested capabilities', type: 'invalid_request_error', param: null, code: 'unsupported_capabilities' },
    });
    assert.deepEqual(upstream.requests, []);
    assert.deepEqual(bridge.state.responses(), []);
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('declared-capability-client-4xx Compatibility Fixture does not switch upstreams', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const rejected = await startRejectedFixture();
  const fallback = await startCompatibilityFixture();
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [
        { baseUrl: rejected.url, apiKey: 'upstream-key', capabilities: supportedCapabilities },
        { baseUrl: fallback.url, apiKey: 'upstream-key', capabilities: supportedCapabilities },
      ],
      statePath: join(dir, 'state.db'),
    });
    const response = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true, input: 'Hello' }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: { message: 'invalid tool', type: 'invalid_request_error', param: null, code: 'upstream_rejected' },
    });
    assert.equal(rejected.requests.length, 1);
    assert.equal(fallback.requests.length, 0);
    assert.deepEqual(bridge.state.responses(), []);
  } finally {
    await bridge?.close();
    await rejected.close();
    await fallback.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Idempotency-Key does not turn a pre-stream upstream rejection into SSE', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startRejectedFixture();
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key', upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }], statePath: join(dir, 'state.db'),
    });
    const headers = { authorization: 'Bearer bridge-key', 'content-type': 'application/json', 'idempotency-key': 'failed-once' };
    const body = JSON.stringify({ stream: true, input: 'Hello' });
    const first = await fetch(`${bridge.url}/v1/responses`, { method: 'POST', headers, body });
    assert.equal(first.status, 400);
    assert.deepEqual(await first.json(), {
      error: { message: 'invalid tool', type: 'invalid_request_error', param: null, code: 'upstream_rejected' },
    });
    const replay = await fetch(`${bridge.url}/v1/responses`, { method: 'POST', headers, body });
    assert.equal(replay.status, 400);
    assert.deepEqual(await replay.json(), {
      error: { message: 'invalid tool', type: 'invalid_request_error', param: null, code: 'upstream_rejected' },
    });
    assert.equal(upstream.requests.length, 2);
    assert.deepEqual(bridge.state.attempts(), []);
    assert.deepEqual(bridge.state.responses(), []);
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('idempotency-in-progress replays persisted events then follows the Response without another Attempt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startIdempotencyFixture();
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key', upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }], statePath: join(dir, 'state.db'),
    });
    const headers = { authorization: 'Bearer bridge-key', 'content-type': 'application/json', 'idempotency-key': 'once' };
    const request = { stream: true, input: 'Hello' };
    const first = await fetch(`${bridge.url}/v1/responses`, { method: 'POST', headers, body: JSON.stringify(request) });
    for (let tries = 0; bridge.state.events().length < 2 && tries < 50; tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(bridge.state.events().map(({ type }) => type), ['response.created', 'response.in_progress', 'response.output_item.added', 'response.output_text.delta']);
    const second = await fetch(`${bridge.url}/v1/responses`, { method: 'POST', headers, body: JSON.stringify(request) });
    upstream.release();
    const [firstBody, secondBody] = await Promise.all([first.text(), second.text()]);
    assert.equal(secondBody, firstBody);
    assert.equal(upstream.requests.length, 1);
    assert.equal(bridge.state.attempts().length, 1);
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('idempotency-terminal replays original SSE and rejects a conflicting request without state changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startIdempotencyFixture();
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key', upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }], statePath: join(dir, 'state.db'),
    });
    const headers = { authorization: 'Bearer bridge-key', 'content-type': 'application/json', 'idempotency-key': 'once' };
    const request = { stream: true, input: 'Hello' };
    const first = await fetch(`${bridge.url}/v1/responses`, { method: 'POST', headers, body: JSON.stringify(request) });
    upstream.release();
    const firstBody = await first.text();
    assert.equal(sseTypes(firstBody).at(-1)?.type, 'response.completed');
    assert.deepEqual(bridge.state.responses(), [{ status: 'completed', outputText: 'first second' }]);
    const replay = await fetch(`${bridge.url}/v1/responses`, { method: 'POST', headers, body: JSON.stringify(request) });
    assert.equal(await replay.text(), firstBody);
    const before = { events: bridge.state.events(), responses: bridge.state.responses(), attempts: bridge.state.attempts() };
    const conflict = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers, body: JSON.stringify({ stream: true, input: 'Different' }),
    });
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), {
      error: { message: 'Idempotency-Key is already used for a different request', type: 'invalid_request_error', param: null, code: 'idempotency_key_conflict' },
    });
    assert.deepEqual({ events: bridge.state.events(), responses: bridge.state.responses(), attempts: bridge.state.attempts() }, before);
    assert.equal(upstream.requests.length, 1);
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('failover-before-output Compatibility Fixture retries the full Response Chain on the next compatible upstream', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const primary = await startScriptedFixture([
    { frames: functionSingleStreams[0] },
    { status: 429 },
  ]);
  const fallback = await startCompatibilityFixture();
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [
        { baseUrl: primary.url, apiKey: 'upstream-key', capabilities: supportedCapabilities },
        { baseUrl: fallback.url, apiKey: 'upstream-key', capabilities: supportedCapabilities },
      ],
      statePath: join(dir, 'state.db'),
    });
    const headers = { authorization: 'Bearer bridge-key', 'content-type': 'application/json' };
    const first = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers,
      body: JSON.stringify({ stream: true, input: 'Weather?', tools: [{ type: 'function', name: 'weather' }] }),
    });
    const firstEvents = sseTypes(await first.text());
    const previousResponseId = (firstEvents.find(({ type }) => type === 'response.completed') as unknown as { response: { id: string } }).response.id;
    const second = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers,
      body: JSON.stringify({
        stream: true, previous_response_id: previousResponseId,
        input: [{ type: 'function_call_output', call_id: 'call_weather', output: 'sunny' }],
      }),
    });
    const events = sseTypes(await second.text());
    assert.equal(events.at(-1)?.type, 'response.completed');
    assert.equal(primary.requests.length, 2);
    assert.equal(fallback.requests.length, 1);
    assert.deepEqual(fallback.requests[0], primary.requests[1]);
    assert.deepEqual((fallback.requests[0] as { messages: unknown[] }).messages, [
      { role: 'user', content: 'Weather?' },
      { role: 'assistant', tool_calls: [{ id: 'call_weather', type: 'function', function: { name: 'weather', arguments: '{"city":"Paris"}' } }] },
      { role: 'tool', tool_call_id: 'call_weather', content: 'sunny' },
    ]);
    assert.equal(bridge.state.attempts().length, 3);
    const attempts = bridge.state.attemptDetails();
    assert.deepEqual(attempts.map(({ attemptIndex, result, preOutputFailure, errorCode }) => ({ attemptIndex, result, preOutputFailure, errorCode })), [
      { attemptIndex: 1, result: 'completed', preOutputFailure: false, errorCode: undefined },
      { attemptIndex: 1, result: 'failed', preOutputFailure: true, errorCode: 'upstream_retryable' },
      { attemptIndex: 2, result: 'completed', preOutputFailure: false, errorCode: undefined },
    ]);
    assert.equal(attempts.every(({ createdAt, finishedAt }) => finishedAt !== undefined && Number.isSafeInteger(createdAt) && Number.isSafeInteger(finishedAt) && finishedAt >= createdAt), true);
  } finally {
    await bridge?.close();
    await primary.close();
    await fallback.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('failure-after-output Compatibility Fixture fails without another Attempt or completion', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const primary = await startScriptedFixture([{ frames: ['data: {"choices":[{"delta":{"content":"partial"}}]}\r\n\r\n'] }]);
  const fallback = await startCompatibilityFixture();
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [
        { baseUrl: primary.url, apiKey: 'upstream-key', capabilities: supportedCapabilities },
        { baseUrl: fallback.url, apiKey: 'upstream-key', capabilities: supportedCapabilities },
      ],
      statePath: join(dir, 'state.db'),
    });
    const response = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true, input: 'Hello' }),
    });
    const events = sseTypes(await response.text());
    assert.deepEqual(events.map(({ type }) => type), ['response.created', 'response.in_progress', 'response.output_item.added', 'response.output_text.delta', 'response.failed']);
    assert.equal(primary.requests.length, 1);
    assert.equal(fallback.requests.length, 0);
    assert.equal(bridge.state.attempts().length, 1);
    assert.deepEqual(bridge.state.responses(), [{ status: 'failed', outputText: 'partial' }]);
  } finally {
    await bridge?.close();
    await primary.close();
    await fallback.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('first-event timeout switches to the next compatible upstream before output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const slow = await startScriptedFixture([{ waitMs: 100 }]);
  const fallback = await startCompatibilityFixture();
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key', firstEventTimeoutMs: 10,
      upstreams: [
        { baseUrl: slow.url, apiKey: 'upstream-key', capabilities: supportedCapabilities },
        { baseUrl: fallback.url, apiKey: 'upstream-key', capabilities: supportedCapabilities },
      ],
      statePath: join(dir, 'state.db'),
    });
    const response = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true, input: 'Hello' }),
    });
    assert.equal(sseTypes(await response.text()).at(-1)?.type, 'response.completed');
    assert.equal(slow.requests.length, 1);
    assert.equal(fallback.requests.length, 1);
    assert.equal(bridge.state.attempts().length, 2);
  } finally {
    await bridge?.close();
    await slow.close();
    await fallback.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a valid first upstream event prevents a first-event timeout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const primary = await startScriptedFixture([{
    waitAfterFirstFrameMs: 30,
    frames: [
      'data: {"choices":[{"delta":{}}]}\r\n\r\n',
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\r\n\r\n',
      'data: [DONE]\r\n\r\n',
    ],
  }]);
  const fallback = await startCompatibilityFixture();
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key', firstEventTimeoutMs: 10,
      upstreams: [
        { baseUrl: primary.url, apiKey: 'upstream-key', capabilities: supportedCapabilities },
        { baseUrl: fallback.url, apiKey: 'upstream-key', capabilities: supportedCapabilities },
      ],
      statePath: join(dir, 'state.db'),
    });
    const response = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true, input: 'Hello' }),
    });
    assert.equal(sseTypes(await response.text()).at(-1)?.type, 'response.completed');
    assert.equal(primary.requests.length, 1);
    assert.equal(fallback.requests.length, 0);
  } finally {
    await bridge?.close();
    await primary.close();
    await fallback.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('all-upstreams-fail Compatibility Fixture returns a pre-output error after a malformed first frame', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const first = await startScriptedFixture([{ status: 429 }]);
  const second = await startScriptedFixture([{ frames: ['data: not-json\r\n\r\n'] }]);
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [
        { baseUrl: first.url, apiKey: 'upstream-key', capabilities: supportedCapabilities },
        { baseUrl: second.url, apiKey: 'upstream-key', capabilities: supportedCapabilities },
      ],
      statePath: join(dir, 'state.db'),
    });
    const response = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true, input: 'Hello' }),
    });
    assert.equal(response.status, 503);
    assert.deepEqual(sseTypes(await response.text()), []);
    assert.equal(first.requests.length, 1);
    assert.equal(second.requests.length, 1);
    assert.deepEqual(bridge.state.attempts(), []);
    assert.deepEqual(bridge.state.responses(), []);
  } finally {
    await bridge?.close();
    await first.close();
    await second.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('client disconnect aborts the active Attempt and cancels the Response', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startIdempotencyFixture();
  const captured = captureStdoutLines();
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }],
      statePath: join(dir, 'state.db'),
    });
    const abort = new AbortController();
    const response = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', signal: abort.signal,
      headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true, input: 'Hello' }),
    });
    for (let tries = 0; bridge.state.events().length < 2 && tries < 50; tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    abort.abort();
    await assert.rejects(() => response.text());
    for (let tries = 0; bridge.state.responses()[0]?.status !== 'cancelled' && tries < 50; tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(bridge.state.responses(), [{ status: 'cancelled', outputText: 'first ' }]);
    assert.deepEqual(bridge.state.events().map(({ type }) => type), ['response.created', 'response.in_progress', 'response.output_item.added', 'response.output_text.delta', 'response.cancelled']);
    assert.equal(bridge.state.attempts().length, 1);
    assert.equal(captured.lines.some((line) => line.includes('http_request_completed') && line.includes('error_code=client_disconnected')), true);
  } finally {
    captured.restore();
    upstream.release();
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('rejects Tool Namespace children that are not Function Tools', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startCompatibilityFixture();
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }],
      statePath: join(dir, 'state.db'),
    });
    const response = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({
        stream: true, input: 'Run shell.',
        tools: [{
          type: 'namespace', name: 'ops', description: 'Ops tools',
          tools: [{ type: 'custom', name: 'shell' }],
        }],
      }),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json() as { error: { code: string } }).error.code, 'unsupported_tools');
    assert.deepEqual(upstream.requests, []);
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Function-only Tool Namespace continues a Response Chain via Completion aliases', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const alias = 'crm__get_customer_profile';
  const streams = [
    [
      `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_crm","type":"function","function":{"name":"${alias}","arguments":"{\\\"customer_id\\\":\\\"1\\\"}"}}]}}]}\r\n\r\n`,
      'data: [DONE]\r\n\r\n',
    ],
    [
      'data: {"choices":[{"delta":{"content":"Profile loaded."}}]}\r\n\r\n',
      'data: [DONE]\r\n\r\n',
    ],
  ];
  const upstream = await startFunctionFixture(streams);
  let bridge: RunningBridge | undefined;
  const parameters = {
    type: 'object',
    properties: { customer_id: { type: 'string' } },
    required: ['customer_id'],
    additionalProperties: false,
  };
  const namespaceTool = {
    type: 'namespace',
    name: 'crm',
    description: 'CRM tools',
    tools: [{
      type: 'function',
      name: 'get_customer_profile',
      description: 'Fetch a customer profile by customer ID.',
      parameters,
      strict: true,
    }],
  };
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: { functionTools: true } }],
      statePath: join(dir, 'state.db'),
    });
    const first = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-test', stream: true, input: 'Lookup customer 1.',
        tools: [namespaceTool],
        tool_choice: { type: 'function', name: 'get_customer_profile', namespace: 'crm' },
      }),
    });
    assert.equal(first.status, 200);
    const firstBody = await first.text();
    const firstEvents = sseTypes(firstBody);
    const firstResponse = firstEvents.find(({ type }) => type === 'response.completed') as unknown as { response: { id: string } };
    const call = firstEvents.find(({ type }) => type === 'response.output_item.done') as unknown as { item: unknown };
    assert.deepEqual(call.item, {
      id: 'call_crm', type: 'function_call', status: 'completed', call_id: 'call_crm',
      name: 'get_customer_profile', namespace: 'crm', arguments: '{"customer_id":"1"}',
    });
    assert.equal(firstBody.includes(alias), false, 'Chat alias must not leak to the Responses client');

    const second = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-test', stream: true, previous_response_id: firstResponse.response.id,
        input: [{ type: 'function_call_output', call_id: 'call_crm', output: '{"name":"Ada"}' }],
      }),
    });
    assert.equal(second.status, 200);
    assert.equal(sseTypes(await second.text()).at(-1)?.type, 'response.completed');
    assert.deepEqual(upstream.requests, [
      {
        model: 'gpt-test', stream: true, stream_options: { include_usage: true },
        messages: [{ role: 'user', content: 'Lookup customer 1.' }],
        tools: [{
          type: 'function',
          function: {
            name: alias,
            description: 'Fetch a customer profile by customer ID.',
            parameters,
            strict: true,
          },
        }],
        tool_choice: { type: 'function', function: { name: alias } },
      },
      {
        model: 'gpt-test', stream: true, stream_options: { include_usage: true },
        messages: [
          { role: 'user', content: 'Lookup customer 1.' },
          {
            role: 'assistant',
            tool_calls: [{ id: 'call_crm', type: 'function', function: { name: alias, arguments: '{"customer_id":"1"}' } }],
          },
          { role: 'tool', tool_call_id: 'call_crm', content: '{"name":"Ada"}' },
        ],
        tools: [{
          type: 'function',
          function: {
            name: alias,
            description: 'Fetch a customer profile by customer ID.',
            parameters,
            strict: true,
          },
        }],
      },
    ]);
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Tool Namespace aliases stay legal and at most 64 characters for overlong names', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const namespace = `ns_${'x'.repeat(80)}`;
  const name = `fn_${'y'.repeat(80)}`;
  const alias = namespaceToolAlias(namespace, name);
  const streams = [[
    `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_long","type":"function","function":{"name":"${alias}","arguments":"{}"}}]}}]}\r\n\r\n`,
    'data: [DONE]\r\n\r\n',
  ]];
  const upstream = await startFunctionFixture(streams);
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: { functionTools: true } }],
      statePath: join(dir, 'state.db'),
    });
    const response = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({
        stream: true, input: 'Call long tool.',
        tools: [{ type: 'namespace', name: namespace, description: 'Long names', tools: [{ type: 'function', name }] }],
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.text();
    const events = sseTypes(body);
    assert.deepEqual((events.find(({ type }) => type === 'response.output_item.done') as unknown as { item: unknown }).item, {
      id: 'call_long', type: 'function_call', status: 'completed', call_id: 'call_long',
      name, namespace, arguments: '{}',
    });
    assert.equal(body.includes(alias), false, 'Chat alias must not leak to the Responses client');
    const forwarded = (upstream.requests[0] as { tools: Array<{ function: { name: string } }> }).tools[0].function.name;
    assert.equal(forwarded, alias);
    assert.equal(forwarded.length, 64);
    assert.match(forwarded, /^[a-zA-Z0-9_-]+$/);
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Tool Namespace alias collisions with a peer Function name are rejected before upstream contact', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startCompatibilityFixture();
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: { functionTools: true } }],
      statePath: join(dir, 'state.db'),
    });
    const response = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({
        stream: true, input: 'Lookup.',
        tools: [
          { type: 'function', name: 'crm__get_customer_profile' },
          {
            type: 'namespace', name: 'crm', description: 'CRM tools',
            tools: [{ type: 'function', name: 'get_customer_profile' }],
          },
        ],
      }),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json() as { error: { code: string } }).error.code, 'unsupported_tools');
    assert.deepEqual(upstream.requests, []);
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('rejects Tool Namespace input missing required fields', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startCompatibilityFixture();
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }],
      statePath: join(dir, 'state.db'),
    });
    const response = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({
        stream: true, input: 'Lookup.',
        tools: [{ type: 'namespace', name: 'crm', tools: [{ type: 'function', name: 'get_customer_profile' }] }],
      }),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json() as { error: { code: string } }).error.code, 'unsupported_tools');
    assert.deepEqual(upstream.requests, []);
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('rejects duplicate Function names inside a Tool Namespace', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startCompatibilityFixture();
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }],
      statePath: join(dir, 'state.db'),
    });
    const response = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({
        stream: true, input: 'Lookup.',
        tools: [{
          type: 'namespace', name: 'crm', description: 'CRM tools',
          tools: [
            { type: 'function', name: 'get_customer_profile' },
            { type: 'function', name: 'get_customer_profile' },
          ],
        }],
      }),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json() as { error: { code: string } }).error.code, 'unsupported_tools');
    assert.deepEqual(upstream.requests, []);
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Tool Namespace requests require functionTools capability', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startCompatibilityFixture();
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: { parallelToolCalls: true } }],
      statePath: join(dir, 'state.db'),
    });
    const response = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({
        stream: true, input: 'Lookup.',
        tools: [{
          type: 'namespace', name: 'crm', description: 'CRM tools',
          tools: [{ type: 'function', name: 'get_customer_profile' }],
        }],
      }),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json() as { error: { code: string } }).error.code, 'unsupported_capabilities');
    assert.deepEqual(upstream.requests, []);
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Codex mixed-tools Compatibility Fixture continues Namespaced Function calls on Completion', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const spawnAlias = 'multi_agent_v1__spawn_agent';
  const spawnArgs = '{"agent_type":"explorer","message":"Find the bridge entrypoint."}';
  const streams = [
    [
      `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_spawn","type":"function","function":{"name":"${spawnAlias}","arguments":${JSON.stringify(spawnArgs)}}}]}}]}\r\n\r\n`,
      'data: [DONE]\r\n\r\n',
    ],
    [
      'data: {"choices":[{"delta":{"content":"Agent spawned."}}]}\r\n\r\n',
      'data: [DONE]\r\n\r\n',
    ],
  ];
  const upstream = await startFunctionFixture(streams);
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: { functionTools: true, parallelToolCalls: true } }],
      statePath: join(dir, 'state.db'),
    });
    const first = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        stream: true,
        input: 'hi',
        tools: codexMixedTools,
        tool_choice: 'auto',
        parallel_tool_calls: true,
      }),
    });
    assert.equal(first.status, 200);
    const firstBody = await first.text();
    const firstEvents = sseTypes(firstBody);
    assert.equal(firstEvents.some(({ type }) => type === 'response.web_search_call.in_progress'), false);
    assert.equal(firstEvents.some(({ type }) => type === 'response.failed'), false);
    const firstResponse = firstEvents.find(({ type }) => type === 'response.completed') as unknown as { response: { id: string } };
    assert.ok(firstResponse?.response.id);
    assert.deepEqual((firstEvents.find(({ type }) => type === 'response.output_item.done') as unknown as { item: unknown }).item, {
      id: 'call_spawn', type: 'function_call', status: 'completed', call_id: 'call_spawn',
      name: 'spawn_agent', namespace: 'multi_agent_v1', arguments: spawnArgs,
    });
    assert.equal(firstBody.includes(spawnAlias), false, 'Chat alias must not leak to the Responses client');

    const second = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-flash', stream: true, previous_response_id: firstResponse.response.id,
        input: [{ type: 'function_call_output', call_id: 'call_spawn', output: '{"agent_id":"agent_1","status":"running"}' }],
      }),
    });
    assert.equal(second.status, 200);
    assert.equal(sseTypes(await second.text()).at(-1)?.type, 'response.completed');

    assert.equal(upstream.requests.length, 2);
    const request = upstream.requests[0] as {
      messages: Array<{ role: string; content?: string }>;
      tools: Array<{ type: string; function: { name: string; strict?: boolean } }>;
      tool_choice?: unknown;
    };
    assert.equal(request.messages[0]?.role, 'system');
    assert.equal(String(request.messages[0]?.content).includes('web search is unavailable'), true);
    assert.equal(request.tools.some((tool) => tool.type === 'web_search' || tool.function?.name === 'web_search'), false);
    assert.deepEqual(request.tools.map((tool) => tool.function.name), [
      'exec_command',
      'multi_agent_v1__close_agent',
      'multi_agent_v1__resume_agent',
      'multi_agent_v1__send_input',
      spawnAlias,
      'multi_agent_v1__wait_agent',
    ]);
    assert.equal(request.tools.every((tool) => tool.function.strict === false), true);
    assert.equal(request.tool_choice, undefined);
    assert.deepEqual(upstream.requests[1], {
      model: 'deepseek-v4-flash', stream: true, stream_options: { include_usage: true }, parallel_tool_calls: true,
      messages: [
        { role: 'system', content: 'Hosted web search is unavailable on this upstream. Do not claim you performed a live web search, cite live results, or invent search calls.' },
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          tool_calls: [{ id: 'call_spawn', type: 'function', function: { name: spawnAlias, arguments: spawnArgs } }],
        },
        { role: 'tool', tool_call_id: 'call_spawn', content: '{"agent_id":"agent_1","status":"running"}' },
      ],
      tools: request.tools,
    });
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Codex mixed-tools Compatibility Fixture rejects illegal Tool Namespace before upstream contact', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startCompatibilityFixture();
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: { functionTools: true, parallelToolCalls: true } }],
      statePath: join(dir, 'state.db'),
    });
    const response = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({
        stream: true, input: 'hi',
        tools: [
          { type: 'function', name: 'exec_command' },
          {
            type: 'namespace', name: 'multi_agent_v1', description: 'Tools for spawning and managing sub-agents.',
            tools: [{ type: 'custom', name: 'spawn_agent' }],
          },
          { type: 'web_search' },
        ],
      }),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json() as { error: { code: string } }).error.code, 'unsupported_tools');
    assert.deepEqual(upstream.requests, []);
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('terminal Compatibility Fixture maps multiline LF SSE length and usage to an incomplete Response', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startScriptedFixture([{
    frames: [
      'event: message\ndata: {"choices":[\ndata: {"delta":{"content":"Hello"},"finish_reason":"length"}]}\n\n',
      'data: {"usage":{"prompt_tokens":2,"completion_tokens":3}}\r\n\r\n',
      'data: [DONE]\r\n\r\n',
    ],
  }]);
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key', upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }], statePath: join(dir, 'state.db'),
    });
    const response = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' }, body: JSON.stringify({ stream: true, input: 'hello' }),
    });
    assert.equal(response.status, 200);
    const events = sseTypes(await response.text()) as Array<{ type: string; response?: { status?: string; usage?: unknown; incomplete_details?: unknown } }>;
    assert.deepEqual(events.map(({ type }) => type), [
      'response.created', 'response.in_progress', 'response.output_item.added', 'response.output_text.delta', 'response.output_item.done', 'response.incomplete',
    ]);
    const terminal = events.at(-1)?.response;
    assert.equal(terminal?.status, 'incomplete');
    assert.deepEqual(terminal?.usage, { input_tokens: 2, output_tokens: 3, total_tokens: 5, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } });
    assert.deepEqual(terminal?.incomplete_details, { reason: 'max_output_tokens' });
    assert.deepEqual(bridge.state.responses(), [{ status: 'incomplete', outputText: 'Hello' }]);
    assert.deepEqual(upstream.requests[0], {
      model: 'gpt-4.1', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'hello' }],
    });
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('non-stream Completion length persists default usage and does not reuse its Idempotency-Key as SSE', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startJsonFixture({ choices: [{ message: { content: 'Cut short' }, finish_reason: 'length' }] });
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key', upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }], statePath: join(dir, 'state.db'),
    });
    const headers = { authorization: 'Bearer bridge-key', 'content-type': 'application/json', 'idempotency-key': 'separate-delivery' };
    const response = await fetch(`${bridge.url}/v1/responses`, { method: 'POST', headers, body: JSON.stringify({ stream: false, input: 'hello' }) });
    assert.equal(response.status, 200);
    const body = await response.json() as { id: string; status: string; incomplete_details?: unknown; usage?: unknown; output: unknown[] };
    assert.deepEqual({ ...body, id: '<local-response-id>' }, {
      id: '<local-response-id>', object: 'response', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
      model: 'gpt-4.1', output: [{
        id: `msg_${body.id}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'Cut short' }],
      }],
    });
    const stream = await fetch(`${bridge.url}/v1/responses`, { method: 'POST', headers, body: JSON.stringify({ stream: true, input: 'hello' }) });
    assert.equal(stream.status, 409);
    assert.equal((await stream.json() as { error: { code: string } }).error.code, 'idempotency_key_conflict');
    assert.equal(upstream.requests.length, 1);
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('SSE Compatibility Fixture preserves normalized errors before and after semantic output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startScriptedFixture([
    { frames: ['event: error\ndata: {"error":{"message":"Invalid tool","type":"upstream_error","param":"tools","code":"invalid_tool"}}\n\n'] },
    { frames: ['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', 'event: error\ndata: {"error":{"message":"Interrupted","type":"upstream_error","param":null,"code":"stream_interrupted"}}\n\n'] },
  ]);
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key', upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }], statePath: join(dir, 'state.db'),
    });
    const headers = { authorization: 'Bearer bridge-key', 'content-type': 'application/json' };
    const beforeOutput = await fetch(`${bridge.url}/v1/responses`, { method: 'POST', headers, body: JSON.stringify({ stream: true, input: 'first' }) });
    assert.equal(beforeOutput.status, 502);
    assert.deepEqual(await beforeOutput.json(), {
      error: { message: 'Invalid tool', type: 'upstream_error', param: 'tools', code: 'invalid_tool' },
    });
    const afterOutput = await fetch(`${bridge.url}/v1/responses`, { method: 'POST', headers, body: JSON.stringify({ stream: true, input: 'second' }) });
    assert.equal(afterOutput.status, 200);
    const terminal = sseTypes(await afterOutput.text()).at(-1) as unknown as { type: string; response: { error: unknown } };
    assert.equal(terminal.type, 'response.failed');
    assert.deepEqual(terminal.response.error, { message: 'Interrupted', type: 'upstream_error', param: null, code: 'stream_interrupted' });
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('streaming reasoning_content produces a reasoning Output Item and restores it on continuation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startScriptedFixture([
    { frames: [
      'data: {"choices":[{"delta":{"reasoning_content":"Let me think."}}]}\r\n\r\n',
      'data: {"choices":[{"delta":{"content":"Hi there."}}]}\r\n\r\n',
      'data: [DONE]\r\n\r\n',
    ] },
    { frames: [
      'data: {"choices":[{"delta":{"content":"ok"}}]}\r\n\r\n',
      'data: [DONE]\r\n\r\n',
    ] },
  ]);
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({ apiKey: 'bridge-key', upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }], statePath: join(dir, 'state.db') });
    const headers = { authorization: 'Bearer bridge-key', 'content-type': 'application/json' };
    const first = await fetch(`${bridge.url}/v1/responses`, { method: 'POST', headers, body: JSON.stringify({ model: 'gpt-test', stream: true, input: 'hi' }) });
    const firstEvents = sseTypes(await first.text());
    const completed = firstEvents.find((event) => event.type === 'response.completed') as unknown as { response: { id: string; output: Array<{ type: string; summary?: Array<{ text: string }>; content?: Array<{ text: string }> }> } };
    assert.deepEqual(completed.response.output.map((item) => item.type), ['reasoning', 'message']);
    assert.equal(completed.response.output[0]!.summary![0]!.text, 'Let me think.');
    assert.equal(completed.response.output[1]!.content![0]!.text, 'Hi there.');
    assert.deepEqual(firstEvents.filter((event) => event.type === 'response.reasoning_summary_text.delta').map((event) => (event as unknown as { output_index: number }).output_index), [0]);
    const second = await fetch(`${bridge.url}/v1/responses`, { method: 'POST', headers, body: JSON.stringify({ model: 'gpt-test', stream: true, previous_response_id: completed.response.id, input: 'more' }) });
    assert.equal(sseTypes(await second.text()).at(-1)?.type, 'response.completed');
    assert.deepEqual((upstream.requests[1] as { messages: Array<{ role: string; reasoning_content?: string; content?: string }> }).messages, [
      { role: 'user', content: 'hi' },
      { role: 'assistant', reasoning_content: 'Let me think.', content: 'Hi there.' },
      { role: 'user', content: 'more' },
    ]);
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('streaming preserves reasoning, text and sharded tool call Output Item order', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startScriptedFixture([{ frames: [
    'data: {"choices":[{"delta":{"reasoning_content":"Planning."}}]}\r\n\r\n',
    'data: {"choices":[{"delta":{"content":"Checking "}}]}\r\n\r\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_weather","type":"function","function":{"name":"weather","arguments":"{\\"city\\":\\""}}]}}]}\r\n\r\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"Paris\\"}"}}]}}]}\r\n\r\n',
    'data: [DONE]\r\n\r\n',
  ] }]);
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({ apiKey: 'bridge-key', upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }], statePath: join(dir, 'state.db') });
    const response = await fetch(`${bridge.url}/v1/responses`, { method: 'POST', headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-test', stream: true, input: 'Check weather.', tools: [{ type: 'function', name: 'weather' }] }) });
    const events = sseTypes(await response.text()) as unknown as Array<{ type: string; output_index?: number; item?: { type: string }; response?: { output: Array<{ type: string }> } }>;
    assert.deepEqual(events.find((event) => event.type === 'response.completed')?.response?.output.map((item) => item.type), ['reasoning', 'message', 'function_call']);
    assert.deepEqual(events.filter((event) => event.type === 'response.output_item.done').map((event) => event.item!.type), ['reasoning', 'message', 'function_call']);
    assert.deepEqual(events.filter((event) => event.type === 'response.reasoning_summary_text.delta').map((event) => event.output_index), [0]);
    assert.deepEqual(events.filter((event) => event.type === 'response.output_text.delta').map((event) => event.output_index), [1]);
    assert.deepEqual(events.filter((event) => event.type === 'response.function_call_arguments.delta').map((event) => event.output_index), [2, 2]);
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('non-stream Response reconstructs reasoning from reasoning_content', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startJsonFixture({ id: 'chatcmpl_x', model: 'gpt-test', choices: [{ message: { role: 'assistant', content: 'Answer.', reasoning_content: 'Because.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } });
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({ apiKey: 'bridge-key', upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }], statePath: join(dir, 'state.db') });
    const response = await fetch(`${bridge.url}/v1/responses`, { method: 'POST', headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-test', stream: false, input: 'hi' }) });
    const body = await response.json() as { output: Array<{ type: string; summary?: Array<{ text: string }>; content?: Array<{ text: string }> }> };
    assert.deepEqual(body.output.map((item) => item.type), ['reasoning', 'message']);
    assert.equal(body.output[0]!.summary![0]!.text, 'Because.');
    assert.equal(body.output[1]!.content![0]!.text, 'Answer.');
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('non-stream Response reconstructs reasoning from a leading think block', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startJsonFixture({ id: 'chatcmpl_y', model: 'gpt-test', choices: [{ message: { role: 'assistant', content: '<think>hidden reasoning</think>visible answer' }, finish_reason: 'stop' }] });
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({ apiKey: 'bridge-key', upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }], statePath: join(dir, 'state.db') });
    const response = await fetch(`${bridge.url}/v1/responses`, { method: 'POST', headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-test', stream: false, input: 'hi' }) });
    const body = await response.json() as { output: Array<{ type: string; summary?: Array<{ text: string }>; content?: Array<{ text: string }> }> };
    assert.deepEqual(body.output.map((item) => item.type), ['reasoning', 'message']);
    assert.equal(body.output[0]!.summary![0]!.text, 'hidden reasoning');
    assert.equal(body.output[1]!.content![0]!.text, 'visible answer');
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('non-stream Response keeps a reasoning-only Output Item when content is null', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startJsonFixture({
    id: 'chatcmpl_r', model: 'gpt-test',
    choices: [{ message: { role: 'assistant', content: null, reasoning_content: 'solo plan', reasoning_details: [{ text: ' detail' }] }, finish_reason: 'stop' }],
  });
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({ apiKey: 'bridge-key', upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }], statePath: join(dir, 'state.db') });
    const response = await fetch(`${bridge.url}/v1/responses`, { method: 'POST', headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-test', stream: false, input: 'hi' }) });
    const body = await response.json() as { output: Array<{ type: string; summary?: Array<{ text: string }> }> };
    assert.equal(response.status, 200);
    assert.deepEqual(body.output.map((item) => item.type), ['reasoning']);
    assert.equal(body.output[0]!.summary![0]!.text, 'solo plan detail');
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('non-stream Response omits an empty message when content is only a think block', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startJsonFixture({
    id: 'chatcmpl_t', model: 'gpt-test',
    choices: [{ message: { role: 'assistant', content: '<think>only reasoning</think>' }, finish_reason: 'stop' }],
  });
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({ apiKey: 'bridge-key', upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }], statePath: join(dir, 'state.db') });
    const response = await fetch(`${bridge.url}/v1/responses`, { method: 'POST', headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-test', stream: false, input: 'hi' }) });
    const body = await response.json() as { output: Array<{ type: string; summary?: Array<{ text: string }> }> };
    assert.equal(response.status, 200);
    assert.deepEqual(body.output.map((item) => item.type), ['reasoning']);
    assert.equal(body.output[0]!.summary![0]!.text, 'only reasoning');
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('streaming leading think shards into a reasoning Output Item then text', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startScriptedFixture([{ frames: [
    'data: {"choices":[{"delta":{"content":"<thin"}}]}\r\n\r\n',
    'data: {"choices":[{"delta":{"content":"k>plan"}}]}\r\n\r\n',
    'data: {"choices":[{"delta":{"content":"</thi"}}]}\r\n\r\n',
    'data: {"choices":[{"delta":{"content":"nk>answer"}}]}\r\n\r\n',
    'data: [DONE]\r\n\r\n',
  ] }]);
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({ apiKey: 'bridge-key', upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }], statePath: join(dir, 'state.db') });
    const response = await fetch(`${bridge.url}/v1/responses`, { method: 'POST', headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-test', stream: true, input: 'hi' }) });
    const events = sseTypes(await response.text()) as unknown as Array<{ type: string; response?: { output: Array<{ type: string; summary?: Array<{ text: string }>; content?: Array<{ text: string }> }> } }>;
    const completed = events.find((event) => event.type === 'response.completed')!;
    assert.deepEqual(completed.response!.output.map((item) => item.type), ['reasoning', 'message']);
    assert.equal(completed.response!.output[0]!.summary![0]!.text, 'plan');
    assert.equal(completed.response!.output[1]!.content![0]!.text, 'answer');
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('streaming restores reasoning alongside a Function Tool call on continuation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startScriptedFixture([
    { frames: [
      'data: {"choices":[{"delta":{"reasoning_content":"Need weather."}}]}\r\n\r\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_weather","type":"function","function":{"name":"weather","arguments":"{\\"city\\":\\"Paris\\"}"}}]}}]}\r\n\r\n',
      'data: [DONE]\r\n\r\n',
    ] },
    { frames: [
      'data: {"choices":[{"delta":{"content":"sunny"}}]}\r\n\r\n',
      'data: [DONE]\r\n\r\n',
    ] },
  ]);
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({ apiKey: 'bridge-key', upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }], statePath: join(dir, 'state.db') });
    const headers = { authorization: 'Bearer bridge-key', 'content-type': 'application/json' };
    const tool = { type: 'function', name: 'weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } };
    const first = await fetch(`${bridge.url}/v1/responses`, { method: 'POST', headers, body: JSON.stringify({ model: 'gpt-test', stream: true, input: 'weather?', tools: [tool] }) });
    const firstEvents = sseTypes(await first.text()) as unknown as Array<{ type: string; response?: { id: string; output: Array<{ type: string }> } }>;
    const firstCompleted = firstEvents.find((event) => event.type === 'response.completed')!;
    assert.deepEqual(firstCompleted.response!.output.map((item) => item.type), ['reasoning', 'function_call']);
    const second = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST', headers,
      body: JSON.stringify({
        model: 'gpt-test', stream: true, previous_response_id: firstCompleted.response!.id, tools: [tool],
        input: [{ type: 'function_call_output', call_id: 'call_weather', output: 'sunny' }],
      }),
    });
    assert.equal(sseTypes(await second.text()).at(-1)?.type, 'response.completed');
    assert.deepEqual((upstream.requests[1] as { messages: Array<{ role: string; reasoning_content?: string; tool_calls?: unknown[]; content?: string }> }).messages, [
      { role: 'user', content: 'weather?' },
      { role: 'assistant', reasoning_content: 'Need weather.', tool_calls: [{ id: 'call_weather', type: 'function', function: { name: 'weather', arguments: '{"city":"Paris"}' } }] },
      { role: 'tool', tool_call_id: 'call_weather', content: 'sunny' },
    ]);
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('streaming does not fabricate a completed reasoning item when the upstream truncates mid-reasoning', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startScriptedFixture([{ frames: [
    'data: {"choices":[{"delta":{"reasoning_content":"partial plan"}}]}\r\n\r\n',
  ] }]);
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({ apiKey: 'bridge-key', upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }], statePath: join(dir, 'state.db') });
    const response = await fetch(`${bridge.url}/v1/responses`, { method: 'POST', headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-test', stream: true, input: 'hi' }) });
    const events = sseTypes(await response.text());
    assert.equal(events.at(-1)?.type, 'response.failed');
    assert.equal(events.some((event) => event.type === 'response.output_item.done'), false);
    assert.equal(events.some((event) => event.type === 'response.reasoning_summary_text.done'), false);
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('streaming does not fabricate a completed tool call when the upstream truncates mid-call', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startScriptedFixture([{ frames: [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"type":"function","function":{"arguments":"{"}}]}}]}\r\n\r\n',
    'data: [DONE]\r\n\r\n',
  ] }]);
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({ apiKey: 'bridge-key', upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }], statePath: join(dir, 'state.db') });
    const response = await fetch(`${bridge.url}/v1/responses`, { method: 'POST', headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-test', stream: true, input: 'Check weather.', tools: [{ type: 'function', name: 'weather' }] }) });
    const events = sseTypes(await response.text());
    // The tool call was announced in_progress but never received an id/name; the Response
    // fails and no output_item.done is fabricated for the unfinished call.
    assert.equal(events.at(-1)?.type, 'response.failed');
    assert.equal(events.some((event) => event.type === 'response.output_item.done'), false);
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('streaming does not fabricate a completed message when the upstream truncates mid-text', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startScriptedFixture([{ frames: [
    'data: {"choices":[{"delta":{"content":"partial answer"}}]}\r\n\r\n',
  ] }]);
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({ apiKey: 'bridge-key', upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }], statePath: join(dir, 'state.db') });
    const response = await fetch(`${bridge.url}/v1/responses`, { method: 'POST', headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-test', stream: true, input: 'hi' }) });
    const events = sseTypes(await response.text());
    // The text item was announced in_progress but the stream ended without [DONE]; the
    // Response fails and no output_item.done is fabricated for the unfinished message.
    assert.equal(events.at(-1)?.type, 'response.failed');
    assert.equal(events.some((event) => event.type === 'response.output_item.done'), false);
  } finally {
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

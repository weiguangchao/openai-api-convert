import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { startBridge, type RunningBridge } from '../src/server.ts';

const sseTypes = (body: string) => [...body.matchAll(/^data: (.+)$/gm)]
  .map((match) => JSON.parse(match[1]) as { type: string });

const startCompatibilityFixture = async () => {
  const requests: unknown[] = [];
  const server = createServer(async (request, response) => {
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

const supportedCapabilities = { functionTools: true, customTools: true, parallelToolCalls: true };

const startCustomFixture = async () => {
  const requests: unknown[] = [];
  const streams = [
    [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_shell","type":"custom","custom":{"name":"shell","input":"ls"}}]}}]}\r\n\r\n',
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

test('State Store startup cleanup removes only expired terminal Response Chains and safe observability', async () => {
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
    const observability = bridge.state.observability();
    assert.equal(observability.deletedChains, 1);
    assert.equal(JSON.stringify(observability).includes('retained input'), false);
    assert.equal(JSON.stringify(observability).includes('bridge-key'), false);
  } finally {
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
    });
    const bytes = bridge.state.observability().bytes;
    await bridge.close();
    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: supportedCapabilities }],
      statePath,
      statePolicy: { cleanupThresholdBytes: Math.max(1, bytes - 1), hardLimitBytes: bytes, responseRetentionDays: 30, attemptRetentionDays: 7 },
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
    assert.equal(bridge.state.observability().capacityRejections, 1);
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

    const nonStreaming = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({ stream: false, input: 'hello' }),
    });
    assert.equal(nonStreaming.status, 400);

    const response = await fetch(`${bridge.url}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer bridge-key', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-test', stream: true, input: 'hello' }),
    });
    assert.equal(response.status, 200);
    const body = await response.text();
    const events = sseTypes(body);
    assert.deepEqual(events.map(({ type }) => type), [
      'response.created', 'response.output_text.delta', 'response.output_text.delta',
      'response.output_item.done', 'response.completed',
    ]);
    assert.equal(body.includes('chat.completion.chunk'), false);
    assert.equal(body.includes('[DONE]'), false);
    assert.deepEqual(upstream.requests, [{
      model: 'gpt-test', stream: true, stream_options: { include_usage: true },
      messages: [{ role: 'user', content: 'hello' }],
    }]);
    assert.deepEqual(bridge.state.events().map((event) => event.sequence), [1, 2, 3, 4, 5]);
    assert.deepEqual(bridge.state.responses(), [{ status: 'completed', outputText: 'Hello world' }]);
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

test('custom-supported Compatibility Fixture selects a native Custom Tool upstream', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const incompatible = await startCompatibilityFixture();
  const compatible = await startCustomFixture();
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [
        { baseUrl: incompatible.url, apiKey: 'upstream-key', capabilities: { functionTools: true } },
        { baseUrl: compatible.url, apiKey: 'upstream-key', capabilities: supportedCapabilities },
      ],
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
    assert.equal(incompatible.requests.length, 0);
    assert.deepEqual(compatible.requests[0], {
      model: 'gpt-4.1', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'List files.' }],
      tools: [{ type: 'custom', custom: { name: 'shell', description: 'Runs shell' } }],
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
    assert.deepEqual(compatible.requests[1], {
      model: 'gpt-4.1', stream: true, stream_options: { include_usage: true },
      messages: [
        { role: 'user', content: 'List files.' },
        { role: 'assistant', tool_calls: [{ id: 'call_shell', type: 'custom', custom: { name: 'shell', input: 'ls' } }] },
        { role: 'tool', tool_call_id: 'call_shell', content: 'file.txt' },
      ],
      tools: [{ type: 'custom', custom: { name: 'shell', description: 'Runs shell' } }],
    });
  } finally {
    await bridge?.close();
    await incompatible.close();
    await compatible.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('custom-incompatible Compatibility Fixture rejects before contacting an upstream', async () => {
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

test('parallel-incompatible Compatibility Fixture rejects before contacting an upstream', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  const upstream = await startFunctionFixture();
  let bridge: RunningBridge | undefined;
  try {
    bridge = await startBridge({
      apiKey: 'bridge-key',
      upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key', capabilities: { functionTools: true, customTools: true, parallelToolCalls: false } }],
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
      error: { message: 'Upstream rejected request', type: 'invalid_request_error', param: null, code: 'upstream_rejected' },
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

test('idempotency-failed replays an upstream rejection without another Attempt', async () => {
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
    const failed = await first.text();
    const replay = await fetch(`${bridge.url}/v1/responses`, { method: 'POST', headers, body });
    assert.equal(await replay.text(), failed);
    assert.deepEqual(sseTypes(failed).map(({ type }) => type), ['response.created', 'response.failed']);
    assert.equal(upstream.requests.length, 1);
    assert.equal(bridge.state.attempts().length, 1);
    assert.deepEqual(bridge.state.responses(), [{ status: 'failed', outputText: '' }]);
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
    assert.deepEqual(bridge.state.events().map(({ type }) => type), ['response.created', 'response.output_text.delta']);
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
    assert.deepEqual(events.map(({ type }) => type), ['response.created', 'response.output_text.delta', 'response.failed']);
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

test('all-upstreams-fail Compatibility Fixture emits response.failed after every compatible upstream', async () => {
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
    assert.deepEqual(sseTypes(await response.text()).map(({ type }) => type), ['response.created', 'response.failed']);
    assert.equal(first.requests.length, 1);
    assert.equal(second.requests.length, 1);
    assert.equal(bridge.state.attempts().length, 2);
    assert.deepEqual(bridge.state.responses(), [{ status: 'failed', outputText: '' }]);
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
    assert.deepEqual(bridge.state.events().map(({ type }) => type), ['response.created', 'response.output_text.delta', 'response.cancelled']);
    assert.equal(bridge.state.attempts().length, 1);
  } finally {
    upstream.release();
    await bridge?.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

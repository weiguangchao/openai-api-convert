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

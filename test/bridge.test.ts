import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('rejects invalid startup configuration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'response-bridge-'));
  try {
    await assert.rejects(() => startBridge({ apiKey: '', upstreams: [], statePath: join(dir, 'state.db') }), /API key/);
    await assert.rejects(() => startBridge({ apiKey: 'bridge-key', upstreams: [], statePath: join(dir, 'state.db') }), /Upstream Pool/);
    await assert.rejects(() => startBridge({
      apiKey: 'bridge-key',
      upstreams: [{ baseUrl: 'http://127.0.0.1:1', apiKey: 'upstream-key' }],
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
      upstreams: [{ baseUrl: upstream.url, apiKey: 'upstream-key' }],
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

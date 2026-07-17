import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { runReleaseSmoke } from '../scripts/release-smoke-lib.ts';

test('release smoke requires a Hosted Web Search event', async () => {
  const upstream = createServer((request, response) => {
    assert.equal(request.url, '/v1/responses');
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end([
      'data: {"type":"response.created","response":{"id":"upstream-response","status":"in_progress","output":[]}}\r\n\r\n',
      'data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"ack"}\r\n\r\n',
      'data: {"type":"response.completed","response":{"id":"upstream-response","status":"completed","output":[]}}\r\n\r\n',
    ].join(''));
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert(address && typeof address !== 'string');
  try {
    await assert.rejects(() => runReleaseSmoke({
      apiKey: 'smoke-bridge-key', model: 'smoke-model',
      upstreams: [{
        baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'smoke-upstream-key', wireApi: 'responses',
        capabilities: { functionTools: true, parallelToolCalls: true, webSearch: true },
      }],
      runCodex: async () => { throw new Error('Codex must not run'); },
    }), /did not execute Hosted Web Search/);
  } finally {
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  }
});

test('release smoke requires Codex to execute Hosted Web Search', async () => {
  const upstream = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (request.url === '/v1/responses') {
      response.end([
        'data: {"type":"response.created","response":{"id":"upstream-response","status":"in_progress","output":[]}}\r\n\r\n',
        'data: {"type":"response.web_search_call.in_progress","output_index":0,"item_id":"search"}\r\n\r\n',
        'data: {"type":"response.completed","response":{"id":"upstream-response","status":"completed","output":[]}}\r\n\r\n',
      ].join(''));
      return;
    }
    assert.equal(request.url, '/v1/chat/completions');
    response.end('data: {"choices":[{"delta":{"content":"ack"}}]}\r\n\r\ndata: [DONE]\r\n\r\n');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert(address && typeof address !== 'string');
  try {
    await assert.rejects(() => runReleaseSmoke({
      apiKey: 'smoke-bridge-key', model: 'smoke-model',
      upstreams: [{
        baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'smoke-upstream-key', wireApi: 'responses',
        capabilities: { functionTools: true, parallelToolCalls: true, webSearch: true },
      }],
      runCodex: async (args, env) => {
        const baseUrl = JSON.parse(args.find((argument) => argument.startsWith('model_providers.response-bridge-smoke.base_url='))!.split('=').slice(1).join('=')) as string;
        await (await fetch(`${baseUrl}/responses`, {
          method: 'POST', headers: { authorization: `Bearer ${env.BRIDGE_API_KEY}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'smoke-model', stream: true, input: 'Reply.' }),
        })).text();
      },
    }), /Codex CLI did not execute Hosted Web Search/);
  } finally {
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  }
});

test('release smoke validates semantic SSE and invokes Codex with an isolated Bridge provider', async () => {
  const requests: Array<{ url: string | undefined; body: unknown }> = [];
  const upstream = createServer((request, response) => {
    assert.equal(request.method, 'POST');
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      requests.push({ url: request.url, body: JSON.parse(body) });
      assert.equal(request.url, '/v1/responses');
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end([
        'data: {"type":"response.created","response":{"id":"upstream-response","status":"in_progress","output":[]}}\r\n\r\n',
        'data: {"type":"response.web_search_call.in_progress","output_index":0,"item_id":"search"}\r\n\r\n',
        'data: {"type":"response.output_text.delta","output_index":1,"content_index":0,"delta":"ack"}\r\n\r\n',
        'data: {"type":"response.completed","response":{"id":"upstream-response","status":"completed","output":[]}}\r\n\r\n',
      ].join(''));
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert(address && typeof address !== 'string');
  const invocations: Array<{ args: string[]; env: Record<string, string | undefined> }> = [];
  const upstreams = [{
    baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'smoke-upstream-key',
    wireApi: 'responses' as const,
    capabilities: { functionTools: true, parallelToolCalls: true, webSearch: true },
  }];
  const inheritedSecret = process.env.RELEASE_SMOKE_TEST_SECRET;
  process.env.RELEASE_SMOKE_TEST_SECRET = 'must-not-reach-codex';
  try {
    await assert.rejects(() => runReleaseSmoke({
      apiKey: 'smoke-bridge-key', model: 'smoke-model',
      upstreams: [{ baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'smoke-upstream-key' }],
      runCodex: async () => {},
    }), /requires Function Tool and parallel Tool Calling/);
    await assert.rejects(() => runReleaseSmoke({
      apiKey: 'smoke-bridge-key',
      model: 'smoke-model',
      upstreams,
      runCodex: async () => {},
    }), /Codex CLI did not complete a Bridge Response/);
    await assert.rejects(() => runReleaseSmoke({
      apiKey: 'smoke-bridge-key', model: 'smoke-model',
      upstreams: [{
        baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'smoke-upstream-key',
        capabilities: { functionTools: true, parallelToolCalls: true, webSearch: true },
      }],
      runCodex: async () => {},
    }), /native Responses upstream with Hosted Web Search support/);
    await assert.rejects(() => runReleaseSmoke({
      apiKey: 'smoke-bridge-key', model: 'smoke-model',
      upstreams: [{
        baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'smoke-upstream-key', wireApi: 'responses',
        capabilities: { functionTools: true, parallelToolCalls: true },
      }],
      runCodex: async () => {},
    }), /native Responses upstream with Hosted Web Search support/);
    await runReleaseSmoke({
      apiKey: 'smoke-bridge-key',
      model: 'smoke-model',
      upstreams,
      runCodex: async (args, env) => {
        invocations.push({ args, env });
        const baseUrl = JSON.parse(args.find((argument) => argument.startsWith('model_providers.response-bridge-smoke.base_url='))!.split('=').slice(1).join('=')) as string;
        const response = await fetch(`${baseUrl}/responses`, {
          method: 'POST',
          headers: { authorization: `Bearer ${env.BRIDGE_API_KEY}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'smoke-model', stream: true,
            input: [
              { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Follow the user.' }] },
              { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Reply.' }] },
            ],
            tools: [{ type: 'web_search' }],
          }),
        });
        assert.equal(response.status, 200);
        await response.text();
      },
    });
    assert.equal(invocations.length, 1);
    assert.equal(invocations[0].env.BRIDGE_API_KEY, 'smoke-bridge-key');
    assert.equal(invocations[0].env.RELEASE_SMOKE_TEST_SECRET, undefined);
    assert.equal(invocations[0].args.includes('--ephemeral'), true);
    assert.equal(invocations[0].args.includes('--ignore-user-config'), true);
    assert.equal(invocations[0].args.includes('web_search="live"'), true);
    assert.equal(invocations[0].args.includes('model_provider="response-bridge-smoke"'), true);
    assert.equal(invocations[0].args.some((argument) => argument.includes('smoke-upstream-key')), false);
    assert.equal(invocations[0].args.some((argument) => argument.includes('smoke-bridge-key')), false);
    const directRequest = requests.find(({ body }) => Array.isArray((body as { tools?: unknown[] }).tools));
    assert.deepEqual(directRequest, {
      url: '/v1/responses',
      body: {
        model: 'smoke-model', stream: true, input: 'Search the web and reply with a short acknowledgement.',
        tools: [{ type: 'web_search' }], tool_choice: { type: 'web_search' }, include: ['web_search_call.action.sources'],
      },
    });
  } finally {
    if (inheritedSecret === undefined) delete process.env.RELEASE_SMOKE_TEST_SECRET;
    else process.env.RELEASE_SMOKE_TEST_SECRET = inheritedSecret;
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  }
});

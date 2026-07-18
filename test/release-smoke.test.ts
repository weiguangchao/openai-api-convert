import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { runReleaseSmoke } from '../scripts/release-smoke-lib.js';

const chatCompletionFrames = [
  'data: {"choices":[{"delta":{"content":"ack"}}]}\r\n\r\n',
  'data: [DONE]\r\n\r\n',
].join('');

test('release smoke completes Hosted Web Search degradation then requires Codex', async () => {
  const upstream = createServer((request, response) => {
    assert.equal(request.url, '/v1/chat/completions');
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(chatCompletionFrames);
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert(address && typeof address !== 'string');
  try {
    await assert.rejects(() => runReleaseSmoke({
      apiKey: 'smoke-bridge-key', model: 'smoke-model',
      upstreams: [{
        baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'smoke-upstream-key',
        capabilities: { functionTools: true, parallelToolCalls: true },
      }],
      runCodex: async () => {},
    }), /Codex CLI did not complete a Bridge Response/);
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
      assert.equal(request.url, '/v1/chat/completions');
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(chatCompletionFrames);
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert(address && typeof address !== 'string');
  const invocations: Array<{ args: string[]; env: Record<string, string | undefined> }> = [];
  const upstreams = [{
    baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'smoke-upstream-key',
    capabilities: { functionTools: true, parallelToolCalls: true },
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
    const directRequest = requests.find(({ body }) => (body as { tool_choice?: unknown }).tool_choice === 'auto');
    assert.equal(directRequest?.url, '/v1/chat/completions');
    assert.equal((directRequest?.body as { tool_choice?: unknown }).tool_choice, 'auto');
    assert.equal(
      ((directRequest?.body as { messages: Array<{ role: string; content: string }> }).messages)
        .some(({ role, content }) => role === 'system' && content.includes('web search is unavailable')),
      true,
    );
  } finally {
    if (inheritedSecret === undefined) delete process.env.RELEASE_SMOKE_TEST_SECRET;
    else process.env.RELEASE_SMOKE_TEST_SECRET = inheritedSecret;
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  }
});

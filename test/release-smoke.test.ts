import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { runCodexProtocolFixture, runReleaseSmoke } from '../scripts/release-smoke-lib.js';

const chatCompletionFrames = [
  'data: {"choices":[{"delta":{"content":"ack"}}]}\r\n\r\n',
  'data: [DONE]\r\n\r\n',
].join('');

const functionCallFrames = (calls: Array<{ id: string; name: string; arguments: string }>) => [
  `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: calls.map((call, index) => ({
    index, id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments },
  })) } }] })}\r\n\r\n`,
  'data: [DONE]\r\n\r\n',
].join('');

const responseEvents = (body: string) => [...body.matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1]) as {
  type: string; response?: { id?: string }; item?: { type?: string; call_id?: string };
});

test('release smoke requires an explicit Release Preflight Model', async () => {
  await assert.rejects(() => runReleaseSmoke({
    apiKey: 'smoke-bridge-key',
    upstreams: [{
      baseUrl: 'http://127.0.0.1:1', apiKey: 'smoke-upstream-key',
      capabilities: { functionTools: true, parallelToolCalls: true },
    }],
    runCodex: async () => {},
  }), /Release Preflight Model is required/);
});

test('release smoke fails before opening a live connection when the complete preflight deadline has elapsed', async () => {
  await assert.rejects(() => runReleaseSmoke({
    apiKey: 'smoke-bridge-key', model: 'smoke-model', deadlineAt: Date.now() - 1,
    upstreams: [{
      baseUrl: 'http://127.0.0.1:1', apiKey: 'smoke-upstream-key',
      capabilities: { functionTools: true, parallelToolCalls: true },
    }],
    getCodexVersion: async () => 'codex-cli 0.144.6',
    runCodex: async () => {},
  }), /Release preflight timed out/);
});

test('Codex Protocol Fixture completes a native exec_command loop through the Bridge', async () => {
  await runCodexProtocolFixture({
    model: 'smoke-model',
    getCodexVersion: async () => 'codex-cli 0.144.6',
    runCodex: async (args, env, timeoutMs) => {
      assert.equal(timeoutMs, 180_000);
      const baseUrl = JSON.parse(args.find((argument) => argument.startsWith('model_providers.response-bridge-protocol-fixture.base_url='))!.split('=').slice(1).join('=')) as string;
      const first = await fetch(`${baseUrl}/responses`, {
        method: 'POST', headers: { authorization: `Bearer ${env.BRIDGE_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'smoke-model', stream: true, input: 'Run pwd.',
          tools: [{ type: 'function', name: 'exec_command', description: 'Runs a command', parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] } }],
        }),
      });
      assert.equal(first.status, 200);
      const firstEvents = responseEvents(await first.text());
      const responseId = firstEvents.find(({ type }) => type === 'response.completed')?.response?.id;
      const callId = firstEvents.find(({ type }) => type === 'response.output_item.done')?.item?.call_id;
      assert.ok(responseId);
      assert.ok(callId);
      const second = await fetch(`${baseUrl}/responses`, {
        method: 'POST', headers: { authorization: `Bearer ${env.BRIDGE_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'smoke-model', stream: true, previous_response_id: responseId,
          input: [{ type: 'function_call_output', call_id: callId, output: '/private/tmp/response-bridge-smoke' }],
        }),
      });
      assert.equal(second.status, 200);
      assert.equal(responseEvents(await second.text()).at(-1)?.type, 'response.completed');
    },
  });
});

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
      getCodexVersion: async () => 'codex-cli 0.144.6',
      runCodex: async () => {},
  }), /Bridge single Function Direct Probe .*did not return the declared Function Tools/);
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
      const parsed = JSON.parse(body) as { tools?: Array<{ function?: { name?: string } }>; messages?: Array<{ role?: string }> };
      requests.push({ url: request.url, body: parsed });
      assert.equal(request.url, '/v1/chat/completions');
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const toolNames = parsed.tools?.map((tool) => tool.function?.name) ?? [];
      const continued = parsed.messages?.some(({ role }) => role === 'tool') === true;
      if (!continued && toolNames.includes('release_smoke_single')) {
        response.end(functionCallFrames([{ id: 'call_single', name: 'release_smoke_single', arguments: '{}' }]));
      } else if (!continued && toolNames.includes('release_smoke_parallel_one')) {
        response.end(functionCallFrames([
          { id: 'call_parallel_one', name: 'release_smoke_parallel_one', arguments: '{}' },
          { id: 'call_parallel_two', name: 'release_smoke_parallel_two', arguments: '{}' },
        ]));
      } else {
        response.end(chatCompletionFrames);
      }
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert(address && typeof address !== 'string');
  const invocations: Array<{ args: string[]; env: Record<string, string | undefined> }> = [];
  const upstreams = [{
    baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'smoke-upstream-key',
    capabilities: { functionTools: true, parallelToolCalls: true },
    thinking: { type: 'disabled' as const },
  }];
  const inheritedSecret = process.env.RELEASE_SMOKE_TEST_SECRET;
  process.env.RELEASE_SMOKE_TEST_SECRET = 'must-not-reach-codex';
  try {
    await assert.rejects(() => runReleaseSmoke({
      apiKey: 'smoke-bridge-key', model: 'smoke-model',
      upstreams: [{ baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'smoke-upstream-key' }],
      getCodexVersion: async () => 'codex-cli 0.144.6',
      runCodex: async () => {},
    }), /requires Function Tool and parallel Tool Calling/);
    await assert.rejects(() => runReleaseSmoke({
      apiKey: 'smoke-bridge-key',
      model: 'smoke-model',
      upstreams,
      getCodexVersion: async () => 'codex-cli 0.144.6',
      runCodex: async () => {},
    }), /Codex CLI .*did not complete a Bridge Response/);
    await runReleaseSmoke({
      apiKey: 'smoke-bridge-key',
      model: 'smoke-model',
      upstreams,
      getCodexVersion: async () => 'codex-cli 0.144.6',
      runCodex: async (args, env) => {
        invocations.push({ args, env });
        const baseUrl = JSON.parse(args.find((argument) => argument.startsWith('model_providers.response-bridge-smoke.base_url='))!.split('=').slice(1).join('=')) as string;
        const response = await fetch(`${baseUrl}/responses`, {
          method: 'POST',
          headers: { authorization: `Bearer ${env.BRIDGE_API_KEY}`, 'content-type': 'application/json' },
          body: JSON.stringify(args.includes('web_search="live"') ? {
            model: 'smoke-model', stream: true,
            input: [
              { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Follow the user.' }] },
              { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Reply.' }] },
            ],
            tools: [{ type: 'web_search' }],
          } : { model: 'smoke-model', stream: true, input: 'Reply with a short acknowledgement.' }),
        });
        assert.equal(response.status, 200);
        await response.text();
      },
    });
    assert.equal(invocations.length, 2);
    assert.equal(invocations[0].env.BRIDGE_API_KEY, 'smoke-bridge-key');
    assert.equal(invocations[0].env.RELEASE_SMOKE_TEST_SECRET, undefined);
    assert.equal(invocations[0].args.includes('--ephemeral'), true);
    assert.equal(invocations[0].args.includes('--ignore-user-config'), true);
    assert.equal(invocations[0].args.includes('web_search="live"'), false);
    assert.equal(invocations[1].args.includes('web_search="live"'), true);
    assert.equal(invocations[0].args.includes('model_provider="response-bridge-smoke"'), true);
    assert.equal(invocations[0].args.some((argument) => argument.includes('smoke-upstream-key')), false);
    assert.equal(invocations[0].args.some((argument) => argument.includes('smoke-bridge-key')), false);
    const degradedWebSearchRequest = requests.find(({ body }) => {
      const messages = (body as { messages?: Array<{ role?: string; content?: string }> }).messages ?? [];
      return messages.some(({ role, content }) => role === 'system' && typeof content === 'string' && content.includes('web search is unavailable'));
    });
    assert.equal(degradedWebSearchRequest?.url, '/v1/chat/completions');
    assert.equal((degradedWebSearchRequest?.body as { tool_choice?: unknown }).tool_choice, undefined);
    assert.equal((degradedWebSearchRequest?.body as { parallel_tool_calls?: unknown }).parallel_tool_calls, undefined);
    assert.equal((degradedWebSearchRequest?.body as { tools?: unknown[] }).tools, undefined);
    assert.equal(
      ((degradedWebSearchRequest?.body as { messages: Array<{ role: string; content: string }> }).messages)
        .some(({ role, content }) => role === 'system' && content.includes('web search is unavailable')),
      true,
    );
    const singleProbe = requests.find(({ body }) => (body as { tool_choice?: { function?: { name?: string } } }).tool_choice?.function?.name === 'release_smoke_single');
    assert.equal(singleProbe !== undefined, true);
    assert.deepEqual((singleProbe?.body as { thinking?: unknown }).thinking, { type: 'disabled' });
    const parallelProbe = requests.find(({ body }) => (body as { parallel_tool_calls?: unknown }).parallel_tool_calls === true);
    assert.equal(parallelProbe !== undefined, true);
    assert.equal(
      requests.some(({ body }) => (body as { messages?: Array<{ role?: string }> }).messages?.some(({ role }) => role === 'tool')),
      true,
    );
  } finally {
    if (inheritedSecret === undefined) delete process.env.RELEASE_SMOKE_TEST_SECRET;
    else process.env.RELEASE_SMOKE_TEST_SECRET = inheritedSecret;
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  }
});

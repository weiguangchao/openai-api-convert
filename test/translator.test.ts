import assert from 'node:assert/strict';
import test from 'node:test';
import { StreamTranslator, buildToolContext } from '../src/adapter.js';

const emptyAliases = () => buildToolContext([]);
const chunk = (delta: Record<string, unknown>) => JSON.stringify({ choices: [{ delta }] });

test('StreamTranslator rejects a tool call with a non-integer index', () => {
  const t = new StreamTranslator('resp_x', emptyAliases());
  assert.throws(() => t.feed(chunk({ tool_calls: [{ index: 1.5, type: 'function' }] })), /Invalid upstream Tool call/);
});

test('StreamTranslator rejects a tool call with a negative index', () => {
  const t = new StreamTranslator('resp_x', emptyAliases());
  assert.throws(() => t.feed(chunk({ tool_calls: [{ index: -1, type: 'function' }] })), /Invalid upstream Tool call/);
});

test('StreamTranslator rejects a tool call with an invalid type', () => {
  const t = new StreamTranslator('resp_x', emptyAliases());
  assert.throws(() => t.feed(chunk({ tool_calls: [{ index: 0, type: 'other' }] })), /Invalid upstream Tool call/);
});

test('StreamTranslator rejects a non-function tool call type (Custom is proxied as a function)', () => {
  const t = new StreamTranslator('resp_x', emptyAliases());
  assert.throws(() => t.feed(chunk({ tool_calls: [{ index: 0, type: 'custom' }] })), /Invalid upstream Tool call/);
});

test('StreamTranslator rejects an incomplete tool call at finalize', () => {
  const t = new StreamTranslator('resp_x', emptyAliases());
  t.feed(chunk({ tool_calls: [{ index: 0, type: 'function', function: { arguments: '{}' } }] }));
  assert.throws(() => t.finalize(), /Incomplete upstream Tool call/);
});

test('StreamTranslator emits an added item before text delta and retains a later usage frame', () => {
  const t = new StreamTranslator('resp_x', emptyAliases());
  assert.deepEqual(t.feed(JSON.stringify({
    choices: [{ delta: { content: 'Hello' }, finish_reason: 'length' }],
  })).map(({ type }) => type), ['response.output_item.added', 'response.output_text.delta']);
  t.feed(JSON.stringify({ usage: { prompt_tokens: 2, completion_tokens: 3, cache_creation_input_tokens: 1 } }));
  assert.equal(t.finishReason, 'incomplete');
  assert.deepEqual(t.usage, {
    input_tokens: 2, output_tokens: 3, total_tokens: 5, input_tokens_details: { cached_tokens: 0, cache_creation_tokens: 1 }, output_tokens_details: { reasoning_tokens: 0 },
  });
});

const shellContext = () => buildToolContext([{ type: 'custom', name: 'shell' }]);

test('StreamTranslator restores a Custom Tool call from a proxied function call', () => {
  const t = new StreamTranslator('resp_x', shellContext());
  t.feed(chunk({ tool_calls: [{ index: 0, id: 'call_shell', type: 'function', function: { name: 'shell', arguments: '{"input":"ls -la"}' } }] }));
  t.finalize();
  assert.deepEqual(t.output, [{
    id: 'call_shell', type: 'custom_tool_call', status: 'completed', call_id: 'call_shell', name: 'shell', input: 'ls -la',
  }]);
});

test('StreamTranslator falls back to raw arguments when the Custom proxy input is malformed', () => {
  const t = new StreamTranslator('resp_x', shellContext());
  t.feed(chunk({ tool_calls: [{ index: 0, id: 'call_shell', type: 'function', function: { name: 'shell', arguments: 'free-form payload' } }] }));
  t.finalize();
  assert.deepEqual(t.output, [{
    id: 'call_shell', type: 'custom_tool_call', status: 'completed', call_id: 'call_shell', name: 'shell', input: 'free-form payload',
  }]);
});

test('StreamTranslator keeps a plain Function call distinct from a Custom proxy', () => {
  const t = new StreamTranslator('resp_x', buildToolContext([{ type: 'custom', name: 'shell' }, { type: 'function', name: 'weather' }]));
  t.feed(chunk({ tool_calls: [{ index: 0, id: 'call_w', type: 'function', function: { name: 'weather', arguments: '{"city":"sf"}' } }] }));
  t.finalize();
  assert.deepEqual(t.output, [{
    id: 'call_w', type: 'function_call', status: 'completed', call_id: 'call_w', name: 'weather', arguments: '{"city":"sf"}',
  }]);
});

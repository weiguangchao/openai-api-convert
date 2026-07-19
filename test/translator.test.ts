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

const toolSearchContext = () => buildToolContext([{ type: 'tool_search', description: 'Discover tools' }]);

test('StreamTranslator restores a tool_search_call from the fixed tool_search proxy', () => {
  const t = new StreamTranslator('resp_x', toolSearchContext());
  t.feed(chunk({ tool_calls: [{ index: 0, id: 'call_ts', type: 'function', function: { name: 'tool_search', arguments: '{}' } }] }));
  const events = t.finalize();
  assert.deepEqual(t.output, [{
    id: 'call_ts', type: 'tool_search_call', status: 'completed', call_id: 'call_ts', execution: 'client', arguments: '{}',
  }]);
  // No dedicated tool_search argument delta/done event exists; only output_item.done is emitted.
  assert.equal(events.some(({ type }) => type === 'response.function_call_arguments.done'), false);
  assert.equal(events.some(({ type }) => type === 'response.output_item.done'), true);
});

test('StreamTranslator emits an added tool_search_call item before finalizing', () => {
  const t = new StreamTranslator('resp_x', toolSearchContext());
  const added = t.feed(chunk({ tool_calls: [{ index: 0, id: 'call_ts', type: 'function', function: { name: 'tool_search', arguments: '{}' } }] }));
  assert.deepEqual(
    added.map(({ type }) => type),
    ['response.output_item.added'],
  );
  assert.deepEqual(added[0], {
    type: 'response.output_item.added', output_index: 0,
    item: { id: 'call_ts', type: 'tool_search_call', status: 'in_progress' },
  });
});

test('StreamTranslator keeps tool_search distinct from a plain function named otherwise', () => {
  const t = new StreamTranslator('resp_x', buildToolContext([{ type: 'tool_search' }, { type: 'function', name: 'weather' }]));
  t.feed(chunk({ tool_calls: [{ index: 0, id: 'call_w', type: 'function', function: { name: 'weather', arguments: '{"city":"sf"}' } }] }));
  t.finalize();
  assert.deepEqual(t.output, [{
    id: 'call_w', type: 'function_call', status: 'completed', call_id: 'call_w', name: 'weather', arguments: '{"city":"sf"}',
  }]);
});

// ---- reasoning extraction ----

test('StreamTranslator extracts delta.reasoning_content into a reasoning Output Item', () => {
  const t = new StreamTranslator('resp_x', emptyAliases());
  const events = t.feed(chunk({ reasoning_content: 'Let me think.' }));
  assert.deepEqual(events.map((event) => event.type), ['response.output_item.added', 'response.reasoning_summary_text.delta']);
  t.feed(chunk({ content: 'Hi there.' }));
  t.finalize();
  assert.deepEqual(t.output, [
    { id: 'rs_resp_x', type: 'reasoning', status: 'completed', summary: [{ type: 'summary_text', text: 'Let me think.' }] },
    { id: 'msg_resp_x', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'Hi there.' }] },
  ]);
});

test('StreamTranslator extracts delta.reasoning into a reasoning Output Item', () => {
  const t = new StreamTranslator('resp_x', emptyAliases());
  t.feed(chunk({ reasoning: 'thought' }));
  t.finalize();
  assert.deepEqual(t.output, [
    { id: 'rs_resp_x', type: 'reasoning', status: 'completed', summary: [{ type: 'summary_text', text: 'thought' }] },
  ]);
});

test('StreamTranslator extracts delta.reasoning_details into a reasoning Output Item', () => {
  const t = new StreamTranslator('resp_x', emptyAliases());
  t.feed(chunk({ reasoning_details: [{ type: 'reasoning_text', text: 'step one' }, { text: ' step two' }] }));
  t.finalize();
  assert.deepEqual(t.output, [
    { id: 'rs_resp_x', type: 'reasoning', status: 'completed', summary: [{ type: 'summary_text', text: 'step one step two' }] },
  ]);
});

test('StreamTranslator emits a reasoning summary done event at finalize', () => {
  const t = new StreamTranslator('resp_x', emptyAliases());
  t.feed(chunk({ reasoning_content: 'plan' }));
  t.feed(chunk({ reasoning_content: 'ned' }));
  const done = t.finalize();
  const summaryDone = done.find((event) => event.type === 'response.reasoning_summary_text.done') as unknown as { text: string };
  assert.equal(summaryDone.text, 'planned');
});

test('StreamTranslator omits a reasoning item when no reasoning is observed', () => {
  const t = new StreamTranslator('resp_x', emptyAliases());
  t.feed(chunk({ content: 'just text' }));
  t.finalize();
  assert.deepEqual(t.output, [
    { id: 'msg_resp_x', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'just text' }] },
  ]);
});

// ---- leading <think> extraction ----

test('StreamTranslator extracts a leading <think> block as reasoning and the rest as text', () => {
  const t = new StreamTranslator('resp_x', emptyAliases());
  t.feed(chunk({ content: '<think>reasoning here</think>answer' }));
  t.finalize();
  assert.deepEqual(t.output, [
    { id: 'rs_resp_x', type: 'reasoning', status: 'completed', summary: [{ type: 'summary_text', text: 'reasoning here' }] },
    { id: 'msg_resp_x', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
  ]);
});

test('StreamTranslator streams a <think> block split across chunk boundaries', () => {
  const t = new StreamTranslator('resp_x', emptyAliases());
  t.feed(chunk({ content: '<thin' }));
  t.feed(chunk({ content: 'k>reason' }));
  t.feed(chunk({ content: 'ing</thi' }));
  t.feed(chunk({ content: 'nk>answer' }));
  t.finalize();
  assert.deepEqual(t.output, [
    { id: 'rs_resp_x', type: 'reasoning', status: 'completed', summary: [{ type: 'summary_text', text: 'reasoning' }] },
    { id: 'msg_resp_x', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
  ]);
});

test('StreamTranslator treats a non-leading <think> as ordinary text', () => {
  const t = new StreamTranslator('resp_x', emptyAliases());
  t.feed(chunk({ content: 'answer <think>not leading</think>' }));
  t.finalize();
  assert.deepEqual(t.output, [
    { id: 'msg_resp_x', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'answer <think>not leading</think>' }] },
  ]);
});

// ---- unified slot ordering ----

test('StreamTranslator assigns reasoning, text and tool call slots at first observable', () => {
  const t = new StreamTranslator('resp_x', buildToolContext([{ type: 'function', name: 'weather' }]));
  t.feed(chunk({ reasoning_content: 'plan' }));
  t.feed(chunk({ content: 'Checking. ' }));
  t.feed(chunk({ tool_calls: [{ index: 0, id: 'call_w', type: 'function', function: { name: 'weather', arguments: '{}' } }] }));
  t.finalize();
  assert.deepEqual(t.output.map((item) => item.type), ['reasoning', 'message', 'function_call']);
  assert.deepEqual(t.output.map((item) => item.type === 'function_call' ? item.call_id : undefined), [undefined, undefined, 'call_w']);
});

test('StreamTranslator finalizes reasoning and tool calls in slot order without text', () => {
  const t = new StreamTranslator('resp_x', buildToolContext([{ type: 'function', name: 'weather' }]));
  t.feed(chunk({ reasoning_content: 'plan' }));
  t.feed(chunk({ tool_calls: [{ index: 0, id: 'call_w', type: 'function', function: { name: 'weather', arguments: '{}' } }] }));
  t.finalize();
  assert.deepEqual(t.output.map((item) => item.type), ['reasoning', 'function_call']);
});

test('StreamTranslator keeps reasoning before out-of-order tool call chunks', () => {
  const t = new StreamTranslator('resp_x', buildToolContext([{ type: 'function', name: 'weather' }, { type: 'function', name: 'time' }]));
  const events: Array<{ type: string; output_index?: number }> = [];
  events.push(...t.feed(chunk({ reasoning_content: 'plan' })));
  events.push(...t.feed(chunk({ tool_calls: [{ index: 1, id: 'call_time', type: 'function', function: { name: 'time', arguments: '{}' } }] })));
  events.push(...t.feed(chunk({ tool_calls: [{ index: 0, id: 'call_weather', type: 'function', function: { name: 'weather', arguments: '{}' } }] })));
  events.push(...t.finalize());
  assert.deepEqual(events.filter((event) => event.type === 'response.function_call_arguments.delta').map((event) => event.output_index), [2, 1]);
  assert.deepEqual(t.output.map((item) => item.type === 'function_call' ? item.call_id : item.type), ['reasoning', 'call_weather', 'call_time']);
});

test('StreamTranslator orders reasoning, a Custom call and a Namespace call by slot', () => {
  const t = new StreamTranslator('resp_x', buildToolContext([
    { type: 'custom', name: 'shell' },
    { type: 'namespace', name: 'weather', description: 'd', tools: [{ type: 'function', name: 'get_forecast', parameters: { type: 'object' } }] },
  ]));
  t.feed(chunk({ reasoning_content: 'plan' }));
  t.feed(chunk({ tool_calls: [{ index: 0, id: 'call_shell', type: 'function', function: { name: 'shell', arguments: '{"input":"ls"}' } }] }));
  t.feed(chunk({ tool_calls: [{ index: 1, id: 'call_ns', type: 'function', function: { name: 'weather__get_forecast', arguments: '{}' } }] }));
  t.finalize();
  assert.deepEqual(t.output.map((item) => item.type), ['reasoning', 'custom_tool_call', 'function_call']);
  assert.deepEqual(t.output[1], { id: 'call_shell', type: 'custom_tool_call', status: 'completed', call_id: 'call_shell', name: 'shell', input: 'ls' });
  assert.deepEqual(t.output[2], { id: 'call_ns', type: 'function_call', status: 'completed', call_id: 'call_ns', name: 'get_forecast', namespace: 'weather', arguments: '{}' });
});

test('StreamTranslator orders reasoning ahead of a Tool Search call by first-observable slots', () => {
  const t = new StreamTranslator('resp_x', toolSearchContext());
  t.feed(chunk({ reasoning_content: 'plan' }));
  t.feed(chunk({ tool_calls: [{ index: 0, id: 'call_ts', type: 'function', function: { name: 'tool_search', arguments: '{"q":"weather"}' } }] }));
  t.finalize();
  assert.deepEqual(t.output.map((item) => item.type), ['reasoning', 'tool_search_call']);
  assert.deepEqual(t.output[1], {
    id: 'call_ts', type: 'tool_search_call', status: 'completed', call_id: 'call_ts', execution: 'client', arguments: '{"q":"weather"}',
  });
});

test('StreamTranslator assigns text before reasoning when text is first observable', () => {
  const t = new StreamTranslator('resp_x', emptyAliases());
  t.feed(chunk({ content: 'visible first' }));
  t.feed(chunk({ reasoning_content: 'late plan' }));
  t.finalize();
  assert.deepEqual(t.output.map((item) => item.type), ['message', 'reasoning']);
  assert.deepEqual(t.output.map((item) => item.type === 'message' ? item.content[0]!.text : item.type === 'reasoning' ? item.summary[0]!.text : undefined), ['visible first', 'late plan']);
});

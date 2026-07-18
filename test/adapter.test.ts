import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ALIAS_HASH_LEN,
  INPUT_ECHO_TYPES,
  REASONING_EFFORTS,
  TOOL_NAME_MAX,
  WEB_SEARCH_UNAVAILABLE_HINT,
  buildNamespaceAliasMaps,
  namespaceToolAlias,
  normalizeFunctionTool,
  normalizeInput,
  normalizeTools,
  parseReasoningEffort,
  sanitizeToolNamePart,
  toChatMessages,
  toChatToolChoice,
  toChatTools,
} from '../src/adapter.js';
import type { StoredResponse, Tool } from '../src/types.js';

const hash8 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, ALIAS_HASH_LEN);

const baseResponse = (overrides: Partial<StoredResponse> = {}): StoredResponse => ({
  id: 'r1', model: 'm', input: [], tools: [], parallelToolCalls: false, output: [], ...overrides,
});

// ---- constants ----

test('INPUT_ECHO_TYPES is the set of echoed type names', () => {
  assert.deepEqual([...INPUT_ECHO_TYPES].sort(), ['custom_tool_call', 'function_call', 'reasoning', 'web_search_call']);
});

test('TOOL_NAME_MAX is 64 and ALIAS_HASH_LEN is 8', () => {
  assert.strictEqual(TOOL_NAME_MAX, 64);
  assert.strictEqual(ALIAS_HASH_LEN, 8);
});

test('WEB_SEARCH_UNAVAILABLE_HINT is the exact constant string', () => {
  assert.strictEqual(
    WEB_SEARCH_UNAVAILABLE_HINT,
    'Hosted web search is unavailable on this upstream. Do not claim you performed a live web search, cite live results, or invent search calls.',
  );
});

// ---- normalizeInput ----

test('normalizeInput: non-empty string becomes single user message', () => {
  assert.deepEqual(normalizeInput('hello'), [{ type: 'message', role: 'user', content: 'hello' }]);
});

test('normalizeInput: empty string returns undefined', () => {
  assert.strictEqual(normalizeInput(''), undefined);
});

test('normalizeInput: non-array and empty array return undefined', () => {
  for (const input of [undefined, null, {}, 42, []]) assert.strictEqual(normalizeInput(input), undefined);
});

test('normalizeInput: user/developer message joins input_text parts', () => {
  assert.deepEqual(
    normalizeInput([{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'a' }, { type: 'input_text', text: 'b' }] }]),
    [{ type: 'message', role: 'user', content: 'ab' }],
  );
  assert.deepEqual(
    normalizeInput([{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'sys' }] }]),
    [{ type: 'message', role: 'developer', content: 'sys' }],
  );
});

test('normalizeInput: message with non-input_text part returns undefined', () => {
  assert.strictEqual(normalizeInput([{ type: 'message', role: 'user', content: [{ type: 'output_text', text: 'x' }] }]), undefined);
});

test('normalizeInput: message with empty or non-array content returns undefined', () => {
  assert.strictEqual(normalizeInput([{ type: 'message', role: 'user', content: [] }]), undefined);
  assert.strictEqual(normalizeInput([{ type: 'message', role: 'user', content: 'hi' }]), undefined);
});

test('normalizeInput: assistant message and echo types are dropped, suffix kept', () => {
  const suffix = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }];
  for (const echo of [
    { type: 'message', role: 'assistant', content: [] },
    { type: 'function_call' },
    { type: 'custom_tool_call' },
    { type: 'web_search_call' },
    { type: 'reasoning' },
  ]) {
    assert.deepEqual(normalizeInput([echo, ...suffix]), [{ type: 'message', role: 'user', content: 'hi' }]);
  }
});

test('normalizeInput: all-echo input returns undefined', () => {
  assert.strictEqual(normalizeInput([{ type: 'reasoning' }, { type: 'function_call' }]), undefined);
});

test('normalizeInput: echo after item drops everything before last echo', () => {
  assert.strictEqual(
    normalizeInput([{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }, { type: 'reasoning' }]),
    undefined,
  );
  assert.deepEqual(
    normalizeInput([
      { type: 'reasoning' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'old' }] },
      { type: 'function_call' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'new' }] },
    ]),
    [{ type: 'message', role: 'user', content: 'new' }],
  );
});

test('normalizeInput: function_call_output and custom_tool_call_output kept with string fields', () => {
  assert.deepEqual(normalizeInput([{ type: 'function_call_output', call_id: 'c1', output: 'r1' }]), [{ type: 'function_call_output', call_id: 'c1', output: 'r1' }]);
  assert.deepEqual(normalizeInput([{ type: 'custom_tool_call_output', call_id: 'c2', output: 'r2' }]), [{ type: 'custom_tool_call_output', call_id: 'c2', output: 'r2' }]);
});

test('normalizeInput: tool output with non-string call_id or output returns undefined', () => {
  assert.strictEqual(normalizeInput([{ type: 'function_call_output', call_id: 1, output: 'r' }]), undefined);
  assert.strictEqual(normalizeInput([{ type: 'custom_tool_call_output', call_id: 'c', output: 2 }]), undefined);
});

test('normalizeInput: invalid item type or non-object item returns undefined', () => {
  assert.strictEqual(normalizeInput([{ type: 'something_else' }]), undefined);
  assert.strictEqual(normalizeInput(['x']), undefined);
  assert.strictEqual(normalizeInput([null]), undefined);
});

// ---- normalizeFunctionTool ----

test('normalizeFunctionTool: name required, description/parameters/strict optional', () => {
  assert.deepEqual(normalizeFunctionTool({ name: 'foo' }), { type: 'function', name: 'foo' });
  assert.deepEqual(
    normalizeFunctionTool({ name: 'foo', description: 'd', parameters: { type: 'object' }, strict: true }),
    { type: 'function', name: 'foo', description: 'd', parameters: { type: 'object' }, strict: true },
  );
});

test('normalizeFunctionTool: missing/empty name, bad description/strict return undefined', () => {
  assert.strictEqual(normalizeFunctionTool({ name: '' }), undefined);
  assert.strictEqual(normalizeFunctionTool({ description: 'd' }), undefined);
  assert.strictEqual(normalizeFunctionTool({ name: 'foo', description: 1 }), undefined);
  assert.strictEqual(normalizeFunctionTool({ name: 'foo', strict: 'yes' }), undefined);
});

test('normalizeFunctionTool: parameters included when defined regardless of type', () => {
  assert.deepEqual(normalizeFunctionTool({ name: 'foo', parameters: null }), { type: 'function', name: 'foo', parameters: null });
  assert.deepEqual(normalizeFunctionTool({ name: 'foo', parameters: undefined }), { type: 'function', name: 'foo' });
});

// ---- normalizeTools ----

test('normalizeTools: undefined and non-array return undefined', () => {
  assert.strictEqual(normalizeTools(undefined), undefined);
  assert.strictEqual(normalizeTools({}), undefined);
  assert.strictEqual(normalizeTools('x'), undefined);
});

test('normalizeTools: web_search passes through', () => {
  assert.deepEqual(normalizeTools([{ type: 'web_search' }]), [{ type: 'web_search' }]);
});

test('normalizeTools: function tool normalized', () => {
  assert.deepEqual(normalizeTools([{ type: 'function', name: 'foo' }]), [{ type: 'function', name: 'foo' }]);
  assert.strictEqual(normalizeTools([{ type: 'function' }]), undefined);
  assert.strictEqual(normalizeTools([{ type: 'function', name: '' }]), undefined);
  assert.strictEqual(normalizeTools([{ type: 'function', name: 'foo', description: 1 }]), undefined);
});

test('normalizeTools: custom tool normalized', () => {
  assert.deepEqual(normalizeTools([{ type: 'custom', name: 'bar' }]), [{ type: 'custom', name: 'bar' }]);
  assert.deepEqual(
    normalizeTools([{ type: 'custom', name: 'bar', description: 'd', format: { x: 1 } }]),
    [{ type: 'custom', name: 'bar', description: 'd', format: { x: 1 } }],
  );
  assert.strictEqual(normalizeTools([{ type: 'custom' }]), undefined);
});

test('normalizeTools: namespace tool with children', () => {
  assert.deepEqual(
    normalizeTools([{ type: 'namespace', name: 'ns', description: 'd', tools: [{ type: 'function', name: 'fn' }] }]),
    [{ type: 'namespace', name: 'ns', description: 'd', tools: [{ type: 'function', name: 'fn' }] }],
  );
});

test('normalizeTools: namespace validation failures', () => {
  assert.strictEqual(normalizeTools([{ type: 'namespace', description: 'd', tools: [] }]), undefined);
  assert.strictEqual(normalizeTools([{ type: 'namespace', name: 'ns', tools: [] }]), undefined);
  assert.strictEqual(normalizeTools([{ type: 'namespace', name: 'ns', description: 'd', tools: {} }]), undefined);
  assert.strictEqual(
    normalizeTools([{ type: 'namespace', name: 'ns', description: 'd', tools: [{ type: 'custom', name: 'fn' }] }]),
    undefined,
  );
  assert.strictEqual(
    normalizeTools([{ type: 'namespace', name: 'ns', description: 'd', tools: [{ type: 'function', name: 'fn' }, { type: 'function', name: 'fn' }] }]),
    undefined,
  );
});

test('normalizeTools: unknown tool type returns undefined', () => {
  assert.strictEqual(normalizeTools([{ type: 'other', name: 'x' }]), undefined);
});

// ---- sanitizeToolNamePart ----

test('sanitizeToolNamePart: replaces non [a-zA-Z0-9_-] with _', () => {
  assert.strictEqual(sanitizeToolNamePart('abc 123!@#'), 'abc_123___');
  assert.strictEqual(sanitizeToolNamePart('a.b-c_d'), 'a_b-c_d');
  assert.strictEqual(sanitizeToolNamePart(''), '');
  assert.strictEqual(sanitizeToolNamePart('weird/stuff'), 'weird_stuff');
});

// ---- namespaceToolAlias ----

test('namespaceToolAlias: basic alias is sanitized prefix + hash', () => {
  const ns = 'weather';
  const name = 'get_forecast';
  const hash = hash8(`${ns}\0${name}`);
  assert.strictEqual(namespaceToolAlias(ns, name, new Set()), `weather_get_forecast_${hash}`);
});

test('namespaceToolAlias: prefix derived from sanitized namespace_name', () => {
  const ns = 'wea.ther';
  const name = 'get.forecast';
  const hash = hash8(`${ns}\0${name}`);
  assert.strictEqual(namespaceToolAlias(ns, name, new Set()), `wea_ther_get_forecast_${hash}`);
});

test('namespaceToolAlias: alias length never exceeds TOOL_NAME_MAX', () => {
  const alias = namespaceToolAlias('a'.repeat(200), 'b'.repeat(200), new Set());
  assert.ok(alias.length <= TOOL_NAME_MAX, `alias too long: ${alias.length}`);
});

test('namespaceToolAlias: prefix not starting alnum gets ns_ prefix', () => {
  const ns = '-foo';
  const name = 'bar';
  const hash = hash8(`${ns}\0${name}`);
  assert.strictEqual(namespaceToolAlias(ns, name, new Set()), `ns_-foo_bar_${hash}`);
});

test('namespaceToolAlias: empty namespace and name yields ns_ prefix', () => {
  const hash = hash8('\0');
  assert.strictEqual(namespaceToolAlias('', '', new Set()), `ns__${hash}`);
});

test('namespaceToolAlias: collision appends hash+n', () => {
  const ns = 'ns';
  const name = 'fn';
  const hash = hash8(`${ns}\0${name}`);
  const base = `ns_fn_${hash}`;
  assert.strictEqual(namespaceToolAlias(ns, name, new Set([base])), `${base}1`);
  assert.strictEqual(namespaceToolAlias(ns, name, new Set([base, `${base}1`, `${base}2`])), `${base}3`);
});

test('namespaceToolAlias: throws after more than 1000 conflicts', () => {
  const ns = 'ns';
  const name = 'fn';
  const hash = hash8(`${ns}\0${name}`);
  const base = `ns_fn_${hash}`;
  const reserved = new Set<string>([base]);
  for (let i = 1; i <= 1000; i += 1) reserved.add(`${base}${i}`);
  assert.throws(() => namespaceToolAlias(ns, name, reserved), /Tool Namespace alias conflict/);
});

// ---- buildNamespaceAliasMaps ----

test('buildNamespaceAliasMaps: maps namespace children to aliases, reserves top-level names', () => {
  const tools: Tool[] = [
    { type: 'function', name: 'top_fn' },
    { type: 'custom', name: 'top_custom' },
    { type: 'namespace', name: 'ns', description: 'd', tools: [{ type: 'function', name: 'child' }] },
  ];
  const { aliasToRef, refToAlias } = buildNamespaceAliasMaps(tools);
  const alias = `ns_child_${hash8('ns\0child')}`;
  assert.strictEqual(refToAlias.get('ns\0child'), alias);
  assert.deepEqual(aliasToRef.get(alias), { name: 'child', namespace: 'ns' });
  assert.strictEqual(refToAlias.has('top_fn'), false);
  assert.strictEqual(aliasToRef.has('top_fn'), false);
});

test('buildNamespaceAliasMaps: duplicate namespace+child name throws', () => {
  const tools: Tool[] = [
    { type: 'namespace', name: 'ns', description: 'd', tools: [{ type: 'function', name: 'fn' }] },
    { type: 'namespace', name: 'ns', description: 'd', tools: [{ type: 'function', name: 'fn' }] },
  ];
  assert.throws(() => buildNamespaceAliasMaps(tools), /Tool Namespace alias conflict/);
});

test('buildNamespaceAliasMaps: different namespaces with same child name do not conflict', () => {
  const tools: Tool[] = [
    { type: 'namespace', name: 'ns1', description: 'd', tools: [{ type: 'function', name: 'fn' }] },
    { type: 'namespace', name: 'ns2', description: 'd', tools: [{ type: 'function', name: 'fn' }] },
  ];
  const { refToAlias } = buildNamespaceAliasMaps(tools);
  assert.ok(refToAlias.has('ns1\0fn'));
  assert.ok(refToAlias.has('ns2\0fn'));
  assert.notStrictEqual(refToAlias.get('ns1\0fn'), refToAlias.get('ns2\0fn'));
});

// ---- toChatTools ----

test('toChatTools: drops web_search and preserves function/custom', () => {
  const tools: Tool[] = [
    { type: 'web_search' },
    { type: 'function', name: 'fn', description: 'd', strict: true },
    { type: 'custom', name: 'c', description: 'd', format: 'text' },
  ];
  assert.deepEqual(toChatTools(tools), [
    { type: 'function', function: { name: 'fn', description: 'd', strict: true } },
    { type: 'custom', custom: { name: 'c', description: 'd', format: 'text' } },
  ]);
});

test('toChatTools: expands namespace children into function tools with aliases', () => {
  const hash = hash8('weather\0get_forecast');
  const tools: Tool[] = [
    { type: 'namespace', name: 'weather', description: 'd', tools: [{ type: 'function', name: 'get_forecast', description: 'd', strict: true }] },
  ];
  assert.deepEqual(toChatTools(tools), [
    { type: 'function', function: { name: `weather_get_forecast_${hash}`, description: 'd', strict: true } },
  ]);
});

// ---- toChatToolChoice ----

test('toChatToolChoice: non-object and non-function type return undefined', () => {
  assert.strictEqual(toChatToolChoice(undefined, []), undefined);
  assert.strictEqual(toChatToolChoice('auto', []), undefined);
  assert.strictEqual(toChatToolChoice(null, []), undefined);
  assert.strictEqual(toChatToolChoice({ type: 'auto' }, []), undefined);
  assert.strictEqual(toChatToolChoice({ type: 'function' }, []), undefined);
});

test('toChatToolChoice: function with name returns function choice', () => {
  assert.deepEqual(toChatToolChoice({ type: 'function', name: 'fn' }, []), { type: 'function', function: { name: 'fn' } });
});

test('toChatToolChoice: namespace function resolves alias', () => {
  const tools: Tool[] = [{ type: 'namespace', name: 'weather', description: 'd', tools: [{ type: 'function', name: 'get_forecast' }] }];
  const hash = hash8('weather\0get_forecast');
  assert.deepEqual(
    toChatToolChoice({ type: 'function', name: 'get_forecast', namespace: 'weather' }, tools),
    { type: 'function', function: { name: `weather_get_forecast_${hash}` } },
  );
});

test('toChatToolChoice: unknown namespace returns null', () => {
  assert.strictEqual(toChatToolChoice({ type: 'function', name: 'fn', namespace: 'unknown' }, []), null);
});

// ---- toChatMessages ----

test('toChatMessages: input messages map to chat roles', () => {
  assert.deepEqual(
    toChatMessages(baseResponse({ input: [
      { type: 'message', role: 'user', content: 'hi' },
      { type: 'message', role: 'developer', content: 'sys' },
      { type: 'function_call_output', call_id: 'c1', output: 'r1' },
    ] })),
    [
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'sys' },
      { role: 'tool', tool_call_id: 'c1', content: 'r1' },
    ],
  );
});

test('toChatMessages: assistant text output joined and appended', () => {
  assert.deepEqual(
    toChatMessages(baseResponse({ output: [{ id: 'o1', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'a' }, { type: 'output_text', text: 'b' }] }] })),
    [{ role: 'assistant', content: 'ab' }],
  );
});

test('toChatMessages: function_call output maps to function tool_call', () => {
  assert.deepEqual(
    toChatMessages(baseResponse({ output: [{ id: 'o1', type: 'function_call', status: 'completed', call_id: 'c1', name: 'fn', arguments: '{}' }] })),
    [{ role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'fn', arguments: '{}' } }] }],
  );
});

test('toChatMessages: custom_tool_call output maps to custom tool_call', () => {
  assert.deepEqual(
    toChatMessages(baseResponse({ output: [{ id: 'o1', type: 'custom_tool_call', status: 'completed', call_id: 'c1', name: 'fn', input: 'data' }] })),
    [{ role: 'assistant', tool_calls: [{ id: 'c1', type: 'custom', custom: { name: 'fn', input: 'data' } }] }],
  );
});

test('toChatMessages: assistant message with both text and tool_calls', () => {
  assert.deepEqual(
    toChatMessages(baseResponse({ output: [
      { id: 'o1', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] },
      { id: 'o2', type: 'function_call', status: 'completed', call_id: 'c1', name: 'fn', arguments: '{}' },
    ] })),
    [{ role: 'assistant', content: 'hello', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'fn', arguments: '{}' } }] }],
  );
});

test('toChatMessages: function_call with namespace resolves alias', () => {
  const tools: Tool[] = [{ type: 'namespace', name: 'weather', description: 'd', tools: [{ type: 'function', name: 'get_forecast' }] }];
  const hash = hash8('weather\0get_forecast');
  assert.deepEqual(
    toChatMessages(baseResponse({ tools, output: [{ id: 'o1', type: 'function_call', status: 'completed', call_id: 'c1', name: 'get_forecast', arguments: '{}', namespace: 'weather' }] })),
    [{ role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: `weather_get_forecast_${hash}`, arguments: '{}' } }] }],
  );
});

test('toChatMessages: function_call with unknown namespace throws', () => {
  assert.throws(
    () => toChatMessages(baseResponse({ output: [{ id: 'o1', type: 'function_call', status: 'completed', call_id: 'c1', name: 'fn', arguments: '{}', namespace: 'unknown' }] })),
    /Tool Namespace alias missing/,
  );
});

test('toChatMessages: no text and no tool_calls yields no assistant message', () => {
  assert.deepEqual(
    toChatMessages(baseResponse({ output: [{ id: 'o1', type: 'web_search_call', status: 'completed' }] })),
    [],
  );
});

// ---- parseReasoningEffort / REASONING_EFFORTS ----

test('REASONING_EFFORTS contains the valid effort set', () => {
  assert.deepEqual([...REASONING_EFFORTS].sort(), ['high', 'low', 'max', 'medium', 'minimal', 'none', 'xhigh']);
});

test('parseReasoningEffort: undefined returns undefined', () => {
  assert.strictEqual(parseReasoningEffort(undefined), undefined);
});

test('parseReasoningEffort: null, array, and non-object return null', () => {
  assert.strictEqual(parseReasoningEffort(null), null);
  assert.strictEqual(parseReasoningEffort([]), null);
  assert.strictEqual(parseReasoningEffort('high'), null);
  assert.strictEqual(parseReasoningEffort(42), null);
});

test('parseReasoningEffort: object without effort or effort undefined returns undefined', () => {
  assert.strictEqual(parseReasoningEffort({}), undefined);
  assert.strictEqual(parseReasoningEffort({ effort: undefined }), undefined);
});

test('parseReasoningEffort: valid effort returns the effort', () => {
  for (const effort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    assert.strictEqual(parseReasoningEffort({ effort }), effort);
  }
});

test('parseReasoningEffort: invalid or non-string effort returns null', () => {
  assert.strictEqual(parseReasoningEffort({ effort: 'invalid' }), null);
  assert.strictEqual(parseReasoningEffort({ effort: 5 }), null);
});

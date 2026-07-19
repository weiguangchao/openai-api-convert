import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ALIAS_HASH_LEN,
  CUSTOM_PROXY_PARAMETERS,
  INPUT_ECHO_TYPES,
  REASONING_EFFORTS,
  TOOL_NAME_MAX,
  WEB_SEARCH_UNAVAILABLE_HINT,
  buildCustomProxyDescription,
  buildToolContext,
  extractCustomInput,
  namespaceToolAlias,
  normalizeFunctionTool,
  normalizeInput,
  normalizeTools,
  parseReasoningEffort,
  toChatMessages,
  toChatToolChoice,
  toChatTools,
} from '../src/adapter.js';
import type { StoredResponse, Tool } from '../src/types.js';

const shortHash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, ALIAS_HASH_LEN);

const baseResponse = (overrides: Partial<StoredResponse> = {}): StoredResponse => ({
  id: 'r1', model: 'm', input: [], tools: [], parallelToolCalls: false, output: [], ...overrides,
});

// ---- constants ----

test('INPUT_ECHO_TYPES is the set of echoed type names', () => {
  assert.deepEqual([...INPUT_ECHO_TYPES].sort(), ['custom_tool_call', 'function_call', 'reasoning', 'web_search_call']);
});

test('TOOL_NAME_MAX is 64 and ALIAS_HASH_LEN is 16', () => {
  assert.strictEqual(TOOL_NAME_MAX, 64);
  assert.strictEqual(ALIAS_HASH_LEN, 16);
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

test('normalizeInput: echo types are dropped and the suffix is kept', () => {
  const suffix = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }];
  for (const echo of [
    { type: 'function_call' },
    { type: 'custom_tool_call' },
    { type: 'web_search_call' },
    { type: 'reasoning' },
  ]) {
    assert.deepEqual(normalizeInput([echo, ...suffix]), [{ type: 'message', role: 'user', content: 'hi' }]);
  }
});

test('normalizeInput: preserves explicit assistant messages, including an empty content array', () => {
  assert.deepEqual(normalizeInput([{ type: 'message', role: 'assistant', content: [] }]), [
    { type: 'message', role: 'assistant', content: [] },
  ]);
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

test('normalizeInput: paired inline function call and output are kept for store:false clients', () => {
  assert.deepEqual(normalizeInput([
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Run pwd.' }] },
    { type: 'function_call', call_id: 'call_pwd', name: 'exec_command', arguments: '{"cmd":"pwd"}' },
    { type: 'function_call_output', call_id: 'call_pwd', output: '/private/tmp' },
  ]), [
    { type: 'message', role: 'user', content: 'Run pwd.' },
    { type: 'function_call', call_id: 'call_pwd', name: 'exec_command', arguments: '{"cmd":"pwd"}' },
    { type: 'function_call_output', call_id: 'call_pwd', output: '/private/tmp' },
  ]);
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

test('normalizeFunctionTool: nested function form is accepted like direct fields', () => {
  assert.deepEqual(
    normalizeFunctionTool({ type: 'function', function: { name: 'foo', description: 'd', parameters: { type: 'object' }, strict: true } }),
    { type: 'function', name: 'foo', description: 'd', parameters: { type: 'object' }, strict: true },
  );
  assert.deepEqual(
    normalizeFunctionTool({ type: 'function', function: { name: 'foo' } }),
    { type: 'function', name: 'foo' },
  );
});

test('normalizeFunctionTool: nested name wins, strict falls back to tool level', () => {
  assert.deepEqual(
    normalizeFunctionTool({ type: 'function', name: 'direct', function: { name: 'nested' } }),
    { type: 'function', name: 'nested' },
  );
  assert.deepEqual(
    normalizeFunctionTool({ type: 'function', function: { name: 'foo' }, strict: true }),
    { type: 'function', name: 'foo', strict: true },
  );
  assert.deepEqual(
    normalizeFunctionTool({ type: 'function', function: { name: 'foo', strict: false }, strict: true }),
    { type: 'function', name: 'foo', strict: false },
  );
});

test('normalizeFunctionTool: nested form does not inherit tool-level description or parameters', () => {
  // name and strict fall back to the tool level, but description and parameters come from `function` only.
  assert.deepEqual(
    normalizeFunctionTool({ type: 'function', name: 'top', description: 'top desc', parameters: { type: 'string' }, function: { name: 'fn' } }),
    { type: 'function', name: 'fn' },
  );
  assert.deepEqual(
    normalizeFunctionTool({ type: 'function', name: 'top', description: 'top desc', function: { name: 'fn', description: 'fn desc', parameters: { type: 'object' } } }),
    { type: 'function', name: 'fn', description: 'fn desc', parameters: { type: 'object' } },
  );
});

test('normalizeFunctionTool: nested form with missing or invalid name returns undefined', () => {
  assert.strictEqual(normalizeFunctionTool({ type: 'function', function: { name: '' } }), undefined);
  assert.strictEqual(normalizeFunctionTool({ type: 'function', function: { description: 'd' } }), undefined);
  assert.strictEqual(normalizeFunctionTool({ type: 'function', function: 'nope' }), undefined);
  assert.strictEqual(normalizeFunctionTool({ type: 'function', function: { name: 'foo', description: 1 } }), undefined);
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

test('normalizeTools: nested function form is accepted and canonicalized', () => {
  assert.deepEqual(
    normalizeTools([{ type: 'function', function: { name: 'foo', description: 'd', parameters: { type: 'object' }, strict: true } }]),
    [{ type: 'function', name: 'foo', description: 'd', parameters: { type: 'object' }, strict: true }],
  );
  assert.deepEqual(
    normalizeTools([{ type: 'function', function: { name: 'bar' } }]),
    [{ type: 'function', name: 'bar' }],
  );
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

// ---- namespaceToolAlias ----

test('namespaceToolAlias: short name is namespace__name with no hash', () => {
  assert.strictEqual(namespaceToolAlias('weather', 'get_forecast'), 'weather__get_forecast');
});

test('namespaceToolAlias: preserves raw namespace and name characters', () => {
  assert.strictEqual(namespaceToolAlias('wea.ther', 'get.forecast'), 'wea.ther__get.forecast');
  assert.strictEqual(namespaceToolAlias('', ''), '__');
});

test('namespaceToolAlias: alias length never exceeds TOOL_NAME_MAX', () => {
  const alias = namespaceToolAlias('a'.repeat(200), 'b'.repeat(200));
  assert.ok(alias.length <= TOOL_NAME_MAX, `alias too long: ${alias.length}`);
});

test('namespaceToolAlias: overlong name truncates to 64 with a short hash suffix', () => {
  const ns = 'a'.repeat(200);
  const name = 'b'.repeat(200);
  const fullName = `${ns}__${name}`;
  const hash = shortHash(fullName);
  const alias = namespaceToolAlias(ns, name);
  assert.strictEqual(alias, `${'a'.repeat(46)}__${hash}`);
  assert.strictEqual(alias.length, TOOL_NAME_MAX);
});

// ---- buildToolContext ----

test('buildToolContext: maps namespace aliases and records custom proxy names', () => {
  const tools: Tool[] = [
    { type: 'function', name: 'top_fn' },
    { type: 'custom', name: 'top_custom' },
    { type: 'namespace', name: 'ns', description: 'd', tools: [{ type: 'function', name: 'child' }] },
  ];
  const { aliasToRef, refToAlias, customNames } = buildToolContext(tools);
  const alias = 'ns__child';
  assert.strictEqual(refToAlias.get('ns\0child'), alias);
  assert.deepEqual(aliasToRef.get(alias), { name: 'child', namespace: 'ns' });
  assert.strictEqual(refToAlias.has('top_fn'), false);
  assert.strictEqual(aliasToRef.has('top_fn'), false);
  assert.deepEqual([...customNames], ['top_custom']);
});

test('buildToolContext: duplicate namespace+child name throws', () => {
  const tools: Tool[] = [
    { type: 'namespace', name: 'ns', description: 'd', tools: [{ type: 'function', name: 'fn' }] },
    { type: 'namespace', name: 'ns', description: 'd', tools: [{ type: 'function', name: 'fn' }] },
  ];
  assert.throws(() => buildToolContext(tools), /Tool Namespace alias conflict/);
});

test('buildToolContext: alias colliding with a peer Function name throws', () => {
  const tools: Tool[] = [
    { type: 'function', name: 'ns__child' },
    { type: 'namespace', name: 'ns', description: 'd', tools: [{ type: 'function', name: 'child' }] },
  ];
  assert.throws(() => buildToolContext(tools), /Tool Namespace alias conflict/);
});

test('buildToolContext: alias colliding with a Custom proxy name throws', () => {
  const tools: Tool[] = [
    { type: 'custom', name: 'ns__child' },
    { type: 'namespace', name: 'ns', description: 'd', tools: [{ type: 'function', name: 'child' }] },
  ];
  assert.throws(() => buildToolContext(tools), /Tool Namespace alias conflict/);
});

test('buildToolContext: custom name colliding with a Function name throws', () => {
  const tools: Tool[] = [
    { type: 'function', name: 'shared' },
    { type: 'custom', name: 'shared' },
  ];
  assert.throws(() => buildToolContext(tools), /Tool name conflict/);
});

test('buildToolContext: duplicate custom names throw', () => {
  const tools: Tool[] = [
    { type: 'custom', name: 'shell' },
    { type: 'custom', name: 'shell' },
  ];
  assert.throws(() => buildToolContext(tools), /Tool name conflict/);
});

test('buildToolContext: different namespaces with same child name do not conflict', () => {
  const tools: Tool[] = [
    { type: 'namespace', name: 'ns1', description: 'd', tools: [{ type: 'function', name: 'fn' }] },
    { type: 'namespace', name: 'ns2', description: 'd', tools: [{ type: 'function', name: 'fn' }] },
  ];
  const { refToAlias } = buildToolContext(tools);
  assert.ok(refToAlias.has('ns1\0fn'));
  assert.ok(refToAlias.has('ns2\0fn'));
  assert.notStrictEqual(refToAlias.get('ns1\0fn'), refToAlias.get('ns2\0fn'));
});

// ---- Custom Tool proxy ----

test('buildCustomProxyDescription: embeds the original Custom tool definition as JSON', () => {
  assert.equal(buildCustomProxyDescription({ type: 'custom', name: 'shell' }), '{"type":"custom","name":"shell"}');
  assert.equal(
    buildCustomProxyDescription({ type: 'custom', name: 'shell', description: 'Runs shell', format: 'text' }),
    '{"type":"custom","name":"shell","description":"Runs shell","format":"text"}',
  );
});

test('CUSTOM_PROXY_PARAMETERS: a single required string input', () => {
  assert.deepEqual(CUSTOM_PROXY_PARAMETERS, {
    type: 'object', properties: { input: { type: 'string' } }, required: ['input'],
  });
});

test('extractCustomInput: prefers the string input envelope and falls back to raw arguments', () => {
  assert.equal(extractCustomInput('{"input":"ls -la"}'), 'ls -la');
  assert.equal(extractCustomInput('{"input":"ls","extra":1}'), 'ls');
  // empty -> raw (empty)
  assert.equal(extractCustomInput(''), '');
  // non-JSON -> raw
  assert.equal(extractCustomInput('not json'), 'not json');
  // non-object JSON -> raw
  assert.equal(extractCustomInput('42'), '42');
  assert.equal(extractCustomInput('"plain"'), '"plain"');
  assert.equal(extractCustomInput('null'), 'null');
  assert.equal(extractCustomInput('[]'), '[]');
  // missing input -> raw
  assert.equal(extractCustomInput('{"other":1}'), '{"other":1}');
  // non-string input -> raw
  assert.equal(extractCustomInput('{"input":5}'), '{"input":5}');
  assert.equal(extractCustomInput('{"input":{"x":1}}'), '{"input":{"x":1}}');
});

// ---- toChatTools ----

test('toChatTools: drops web_search, keeps functions and proxies custom as a function', () => {
  const tools: Tool[] = [
    { type: 'web_search' },
    { type: 'function', name: 'fn', description: 'd', strict: true },
    { type: 'custom', name: 'c', description: 'd', format: 'text' },
  ];
  assert.deepEqual(toChatTools(tools), [
    { type: 'function', function: { name: 'fn', description: 'd', parameters: { type: 'object', properties: {} }, strict: true } },
    { type: 'function', function: { name: 'c', description: buildCustomProxyDescription({ type: 'custom', name: 'c', description: 'd', format: 'text' }), parameters: CUSTOM_PROXY_PARAMETERS } },
  ]);
});

test('toChatTools: expands namespace children into function tools with aliases', () => {
  const tools: Tool[] = [
    { type: 'namespace', name: 'weather', description: 'd', tools: [{ type: 'function', name: 'get_forecast', description: 'd', strict: true }] },
  ];
  assert.deepEqual(toChatTools(tools), [
    { type: 'function', function: { name: 'weather__get_forecast', description: 'd', parameters: { type: 'object', properties: {} }, strict: true } },
  ]);
});

test('toChatTools: normalizes missing/null/non-object function parameters to an object schema', () => {
  const tools: Tool[] = [
    { type: 'function', name: 'no_params' },
    { type: 'function', name: 'null_params', parameters: null },
    { type: 'function', name: 'array_params', parameters: [{ type: 'string' }] },
  ];
  assert.deepEqual(toChatTools(tools), [
    { type: 'function', function: { name: 'no_params', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'null_params', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'array_params', parameters: { type: 'object', properties: {} } } },
  ]);
});

test('toChatTools: keeps an object schema but ensures parameters.type is object', () => {
  const tools: Tool[] = [
    { type: 'function', name: 'typed', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } },
    { type: 'function', name: 'missing_type', parameters: { properties: { city: { type: 'string' } } } },
    { type: 'function', name: 'wrong_type', parameters: { type: 'string', description: 'x' } },
  ];
  assert.deepEqual(toChatTools(tools), [
    { type: 'function', function: { name: 'typed', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } },
    { type: 'function', function: { name: 'missing_type', parameters: { type: 'object', properties: { city: { type: 'string' } } } } },
    { type: 'function', function: { name: 'wrong_type', parameters: { type: 'object', description: 'x' } } },
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
  assert.deepEqual(
    toChatToolChoice({ type: 'function', name: 'get_forecast', namespace: 'weather' }, tools),
    { type: 'function', function: { name: 'weather__get_forecast' } },
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

test('toChatMessages: custom_tool_call output maps to a proxied function tool_call', () => {
  assert.deepEqual(
    toChatMessages(baseResponse({ output: [{ id: 'o1', type: 'custom_tool_call', status: 'completed', call_id: 'c1', name: 'fn', input: 'data' }] })),
    [{ role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'fn', arguments: '{"input":"data"}' } }] }],
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
  assert.deepEqual(
    toChatMessages(baseResponse({ tools, output: [{ id: 'o1', type: 'function_call', status: 'completed', call_id: 'c1', name: 'get_forecast', arguments: '{}', namespace: 'weather' }] })),
    [{ role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'weather__get_forecast', arguments: '{}' } }] }],
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
  assert.deepEqual([...REASONING_EFFORTS].sort(), ['high', 'low', 'max', 'medium', 'minimal', 'none', 'ultra', 'xhigh']);
});

test('parseReasoningEffort: undefined and null return undefined', () => {
  assert.strictEqual(parseReasoningEffort(undefined), undefined);
  assert.strictEqual(parseReasoningEffort(null), undefined);
});

test('parseReasoningEffort: array and non-string scalar return null', () => {
  assert.strictEqual(parseReasoningEffort([]), null);
  assert.strictEqual(parseReasoningEffort(42), null);
});

test('parseReasoningEffort: object without effort or effort undefined returns undefined', () => {
  assert.strictEqual(parseReasoningEffort({}), undefined);
  assert.strictEqual(parseReasoningEffort({ effort: undefined }), undefined);
});

test('parseReasoningEffort: valid effort returns the effort', () => {
  for (const effort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
    assert.strictEqual(parseReasoningEffort({ effort }), effort);
  }
});

test('parseReasoningEffort: valid scalar effort returns the effort', () => {
  for (const effort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
    assert.strictEqual(parseReasoningEffort(effort), effort);
  }
});

test('parseReasoningEffort: invalid or non-string effort returns null', () => {
  assert.strictEqual(parseReasoningEffort({ effort: 'invalid' }), null);
  assert.strictEqual(parseReasoningEffort({ effort: 5 }), null);
});

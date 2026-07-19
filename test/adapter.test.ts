import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ALIAS_HASH_LEN,
  CUSTOM_PROXY_PARAMETERS,
  INPUT_ECHO_TYPES,
  REASONING_EFFORTS,
  TOOL_NAME_MAX,
  TOOL_SEARCH_PROXY_NAME,
  TOOL_SEARCH_PROXY_PARAMETERS,
  WEB_SEARCH_UNAVAILABLE_HINT,
  buildCustomProxyDescription,
  buildToolContext,
  extractCustomInput,
  extractReasoningText,
  LeadingThinkParser,
  splitLeadingThink,
  namespaceToolAlias,
  normalizeFunctionTool,
  normalizeInput,
  normalizeTools,
  parseReasoningEffort,
  toChatMessages,
  toChatToolChoice,
  toChatTools,
  toolSearchOutputContent,
} from '../src/adapter.js';
import type { StoredResponse, Tool } from '../src/types.js';

const shortHash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, ALIAS_HASH_LEN);

const baseResponse = (overrides: Partial<StoredResponse> = {}): StoredResponse => ({
  id: 'r1', model: 'm', input: [], tools: [], parallelToolCalls: false, output: [], ...overrides,
});

// ---- constants ----

test('INPUT_ECHO_TYPES is the set of echoed type names', () => {
  assert.deepEqual([...INPUT_ECHO_TYPES].sort(), ['custom_tool_call', 'function_call', 'reasoning', 'tool_search_call', 'web_search_call']);
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

// ---- normalizeInput: Tool Search ----

test('normalizeInput: tool_search_call is an echo type dropped before the suffix', () => {
  assert.deepEqual(
    normalizeInput([{ type: 'tool_search_call', call_id: 'ts_1', arguments: '{}' }, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }]),
    [{ type: 'message', role: 'user', content: 'hi' }],
  );
});

test('normalizeInput: tool_search_output normalizes loaded tools and keeps call_id', () => {
  assert.deepEqual(
    normalizeInput([{ type: 'tool_search_output', call_id: 'ts_1', tools: [{ type: 'function', name: 'get_weather', description: 'd', parameters: { type: 'object' } }] }]),
    [{ type: 'tool_search_output', call_id: 'ts_1', tools: [{ type: 'function', name: 'get_weather', description: 'd', parameters: { type: 'object' } }] }],
  );
});

test('normalizeInput: tool_search_output with missing call_id or invalid tools returns undefined', () => {
  assert.strictEqual(normalizeInput([{ type: 'tool_search_output', tools: [] }]), undefined);
  assert.strictEqual(normalizeInput([{ type: 'tool_search_output', call_id: 'ts_1', tools: [{ type: 'file_search' }] }]), undefined);
  assert.strictEqual(normalizeInput([{ type: 'tool_search_output', call_id: 'ts_1', tools: 'nope' }]), undefined);
});

test('normalizeInput: paired inline tool_search_call and output are kept for store:false clients', () => {
  assert.deepEqual(
    normalizeInput([
      { type: 'tool_search_call', call_id: 'ts_1', arguments: '{}' },
      { type: 'tool_search_output', call_id: 'ts_1', tools: [{ type: 'function', name: 'get_weather' }] },
    ]),
    [
      { type: 'tool_search_call', call_id: 'ts_1', arguments: '{}' },
      { type: 'tool_search_output', call_id: 'ts_1', tools: [{ type: 'function', name: 'get_weather' }] },
    ],
  );
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

test('normalizeTools: tool_search normalized with optional description; execution is not stored', () => {
  assert.deepEqual(normalizeTools([{ type: 'tool_search' }]), [{ type: 'tool_search' }]);
  assert.deepEqual(normalizeTools([{ type: 'tool_search', description: 'Discover tools' }]), [{ type: 'tool_search', description: 'Discover tools' }]);
  assert.deepEqual(normalizeTools([{ type: 'tool_search', execution: 'server', parameters: {} }]), [{ type: 'tool_search' }]);
  assert.strictEqual(normalizeTools([{ type: 'tool_search', description: 1 }]), undefined);
  // execution is never stored, so any value is accepted and dropped rather than validated.
  assert.deepEqual(normalizeTools([{ type: 'tool_search', execution: 'bogus' }]), [{ type: 'tool_search' }]);
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

// ---- Tool Search context ----

test('buildToolContext: tool_search registers the fixed proxy name', () => {
  const { toolSearchNames, customNames, aliasToRef } = buildToolContext([{ type: 'tool_search', description: 'd' }]);
  assert.deepEqual([...toolSearchNames], [TOOL_SEARCH_PROXY_NAME]);
  assert.deepEqual([...customNames], []);
  assert.equal(aliasToRef.has(TOOL_SEARCH_PROXY_NAME), false);
});

test('buildToolContext: a Function named tool_search conflicts with the proxy', () => {
  assert.throws(() => buildToolContext([{ type: 'tool_search' }, { type: 'function', name: 'tool_search' }]), /Tool name conflict/);
  assert.throws(() => buildToolContext([{ type: 'function', name: 'tool_search' }, { type: 'tool_search' }]), /Tool name conflict/);
});

test('buildToolContext: a Custom named tool_search conflicts with the proxy', () => {
  assert.throws(() => buildToolContext([{ type: 'tool_search' }, { type: 'custom', name: 'tool_search' }]), /Tool name conflict/);
});

test('buildToolContext: duplicate tool_search tools conflict', () => {
  assert.throws(() => buildToolContext([{ type: 'tool_search' }, { type: 'tool_search' }]), /Tool name conflict/);
});

test('buildToolContext: tool_search coexists with namespace and function tools', () => {
  const tools: Tool[] = [
    { type: 'tool_search' },
    { type: 'namespace', name: 'ns', description: 'd', tools: [{ type: 'function', name: 'tool_search_child' }] },
    { type: 'function', name: 'get_weather' },
  ];
  const { toolSearchNames, refToAlias } = buildToolContext(tools);
  assert.deepEqual([...toolSearchNames], [TOOL_SEARCH_PROXY_NAME]);
  assert.ok(refToAlias.has('ns\0tool_search_child'));
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

// ---- toChatTools: Tool Search ----

test('toChatTools: tool_search proxies as the fixed tool_search function with empty parameters', () => {
  assert.deepEqual(toChatTools([{ type: 'tool_search', description: 'Discover tools' }]), [
    { type: 'function', function: { name: TOOL_SEARCH_PROXY_NAME, description: 'Discover tools', parameters: TOOL_SEARCH_PROXY_PARAMETERS } },
  ]);
  assert.deepEqual(toChatTools([{ type: 'tool_search' }]), [
    { type: 'function', function: { name: TOOL_SEARCH_PROXY_NAME, parameters: TOOL_SEARCH_PROXY_PARAMETERS } },
  ]);
});

test('toChatTools: tool_search sits alongside function and custom tools', () => {
  const tools: Tool[] = [
    { type: 'tool_search', description: 'Discover tools' },
    { type: 'function', name: 'get_weather' },
    { type: 'custom', name: 'shell' },
  ];
  assert.deepEqual(toChatTools(tools), [
    { type: 'function', function: { name: 'tool_search', description: 'Discover tools', parameters: TOOL_SEARCH_PROXY_PARAMETERS } },
    { type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'shell', description: buildCustomProxyDescription({ type: 'custom', name: 'shell' }), parameters: CUSTOM_PROXY_PARAMETERS } },
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

// ---- toChatMessages: Tool Search ----

const loadedWeatherTool = { type: 'function', name: 'get_weather', description: 'Get weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } as const;

test('toChatMessages: tool_search_call output maps to a tool_search function tool_call', () => {
  assert.deepEqual(
    toChatMessages(baseResponse({ output: [{ id: 'ts_1', type: 'tool_search_call', status: 'completed', call_id: 'ts_1', execution: 'client', arguments: '{}' }] })),
    [{ role: 'assistant', tool_calls: [{ id: 'ts_1', type: 'function', function: { name: 'tool_search', arguments: '{}' } }] }],
  );
});

test('toChatMessages: inline tool_search_call input maps to a tool_search function tool_call', () => {
  assert.deepEqual(
    toChatMessages(baseResponse({ input: [{ type: 'tool_search_call', call_id: 'ts_1', arguments: '{}' }] })),
    [{ role: 'assistant', tool_calls: [{ id: 'ts_1', type: 'function', function: { name: 'tool_search', arguments: '{}' } }] }],
  );
});

test('toChatMessages: tool_search_output input maps to a tool message carrying the loaded tools', () => {
  assert.deepEqual(
    toChatMessages(baseResponse({ input: [{ type: 'tool_search_output', call_id: 'ts_1', tools: [loadedWeatherTool] }] })),
    [{ role: 'tool', tool_call_id: 'ts_1', content: toolSearchOutputContent([loadedWeatherTool]) }],
  );
});

test('toChatMessages: tool_search_call output continues alongside loaded function calls', () => {
  const tools: Tool[] = [{ type: 'tool_search' }, loadedWeatherTool];
  assert.deepEqual(
    toChatMessages(baseResponse({ tools, output: [
      { id: 'ts_1', type: 'tool_search_call', status: 'completed', call_id: 'ts_1', execution: 'client', arguments: '{}' },
      { id: 'c1', type: 'function_call', status: 'completed', call_id: 'c1', name: 'get_weather', arguments: '{"city":"Paris"}' },
    ] })),
    [{ role: 'assistant', tool_calls: [
      { id: 'ts_1', type: 'function', function: { name: 'tool_search', arguments: '{}' } },
      { id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } },
    ] }],
  );
});

test('toChatMessages: a namespace call resolves via a tool loaded by tool_search_output', () => {
  // The namespace tool is not declared in response.tools; it was discovered in-line, so
  // the alias must be rebuilt from the persisted tool_search_output input on continuation.
  const loadedNamespace: Tool[] = [{ type: 'namespace', name: 'weather', description: 'd', tools: [{ type: 'function', name: 'get_forecast' }] }];
  assert.deepEqual(
    toChatMessages(baseResponse({
      tools: [],
      input: [{ type: 'tool_search_output', call_id: 'ts_1', tools: loadedNamespace }],
    output: [{ id: 'c1', type: 'function_call', status: 'completed', call_id: 'c1', name: 'get_forecast', arguments: '{}', namespace: 'weather' }],
    })),
    [
      { role: 'tool', tool_call_id: 'ts_1', content: toolSearchOutputContent(loadedNamespace) },
      { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'weather__get_forecast', arguments: '{}' } }] },
    ],
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


// ---- reasoning extraction helpers ----

test('extractReasoningText concatenates reasoning_content, reasoning and reasoning_details text', () => {
  assert.equal(extractReasoningText({}), '');
  assert.equal(extractReasoningText({ reasoning_content: 'a' }), 'a');
  assert.equal(extractReasoningText({ reasoning: 'b' }), 'b');
  assert.equal(extractReasoningText({ reasoning_content: 'a', reasoning: 'b' }), 'ab');
  assert.equal(extractReasoningText({ reasoning_details: [{ type: 'reasoning_text', text: 'c' }, { text: 'd' }, { noise: 1 }] }), 'cd');
  assert.equal(extractReasoningText({ reasoning_content: 'a', reasoning_details: [{ text: 'b' }] }), 'ab');
});

test('splitLeadingThink: no leading think returns content untouched', () => {
  assert.deepEqual(splitLeadingThink('hello'), { reasoning: '', text: 'hello' });
  assert.deepEqual(splitLeadingThink(''), { reasoning: '', text: '' });
});

test('splitLeadingThink: leading think block splits reasoning and text', () => {
  assert.deepEqual(splitLeadingThink('<think>reasoning</think>answer'), { reasoning: 'reasoning', text: 'answer' });
  assert.deepEqual(splitLeadingThink('<think>reasoning</think>'), { reasoning: 'reasoning', text: '' });
});

test('splitLeadingThink: unclosed leading think consumes the remainder as reasoning', () => {
  assert.deepEqual(splitLeadingThink('<think>ongoing'), { reasoning: 'ongoing', text: '' });
});

test('LeadingThinkParser: non-think content streams as text', () => {
  const parser = new LeadingThinkParser();
  assert.deepEqual(parser.feed('hello world'), { reasoning: '', text: 'hello world' });
  assert.deepEqual(parser.feed(' more'), { reasoning: '', text: ' more' });
  assert.deepEqual(parser.flush(), { reasoning: '', text: '' });
});

test('LeadingThinkParser classifies a leading think block and trailing text across chunks', () => {
  const parser = new LeadingThinkParser();
  const out: Array<{ reasoning: string; text: string }> = [];
  for (const c of ['<think>', 'reasoning', ' here', '</think>', 'answer']) out.push(parser.feed(c));
  out.push(parser.flush());
  assert.equal(out.map((part) => part.reasoning).join(''), 'reasoning here');
  assert.equal(out.map((part) => part.text).join(''), 'answer');
});

test('LeadingThinkParser flushes a partial tag prefix as text when it is not a think block', () => {
  const parser = new LeadingThinkParser();
  assert.deepEqual(parser.feed('<'), { reasoning: '', text: '' });
  assert.deepEqual(parser.feed('hello'), { reasoning: '', text: '<hello' });
  assert.deepEqual(parser.flush(), { reasoning: '', text: '' });
});

test('LeadingThinkParser treats an unclosed leading think as reasoning at flush', () => {
  const parser = new LeadingThinkParser();
  assert.deepEqual(parser.feed('<think>still'), { reasoning: '', text: '' });
  assert.deepEqual(parser.flush(), { reasoning: 'still', text: '' });
});

// ---- toChatMessages reasoning restoration ----

test('toChatMessages restores reasoning_content on the assistant message', () => {
  const messages = toChatMessages(baseResponse({
    input: [{ type: 'message', role: 'user', content: 'hi' }],
    output: [
      { id: 'rs_r1', type: 'reasoning', status: 'completed', summary: [{ type: 'summary_text', text: 'plan' }] },
      { id: 'msg_r1', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
    ],
  }));
  assert.deepEqual(messages, [
    { role: 'user', content: 'hi' },
    { role: 'assistant', reasoning_content: 'plan', content: 'answer' },
  ]);
});

test('toChatMessages restores reasoning alongside tool calls in one assistant message', () => {
  const messages = toChatMessages(baseResponse({
    input: [{ type: 'message', role: 'user', content: 'hi' }],
    tools: [{ type: 'function', name: 'weather', parameters: { type: 'object' } }],
    output: [
      { id: 'rs_r1', type: 'reasoning', status: 'completed', summary: [{ type: 'summary_text', text: 'plan' }] },
      { id: 'call_w', type: 'function_call', status: 'completed', call_id: 'call_w', name: 'weather', arguments: '{"city":"Paris"}' },
    ],
  }));
  assert.deepEqual(messages, [
    { role: 'user', content: 'hi' },
    { role: 'assistant', reasoning_content: 'plan', tool_calls: [{ id: 'call_w', type: 'function', function: { name: 'weather', arguments: '{"city":"Paris"}' } }] },
  ]);
});

test('toChatMessages omits reasoning_content when the ancestor produced no reasoning', () => {
  const messages = toChatMessages(baseResponse({
    input: [{ type: 'message', role: 'user', content: 'hi' }],
    output: [
      { id: 'msg_r1', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
    ],
  }));
  assert.deepEqual(messages, [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'answer' },
  ]);
});

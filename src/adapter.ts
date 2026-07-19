import { createHash } from 'node:crypto';
import type { ChatContentPart, ChatMessage, ChatToolCall, CustomTool, FunctionTool, InputItem, OutputItem, ResponseEvent, ResponsesPayload, ResponsesUsage, Result, StoredResponse, Tool } from './types.js';

export const INPUT_ECHO_TYPES = new Set(['function_call', 'custom_tool_call', 'tool_search_call', 'web_search_call', 'reasoning']);

export const normalizeInput = (input: unknown): InputItem[] | undefined => {
  if (typeof input === 'string' && input.length > 0) return [{ type: 'message', role: 'user', content: input }];
  if (!Array.isArray(input) || input.length === 0) return undefined;
  const inlineCallIndexes = new Set<number>();
  for (let index = 0; index < input.length; index += 1) {
    const item = input[index];
    if (!item || typeof item !== 'object') continue;
    const value = item as Record<string, unknown>;
    if ((value.type !== 'function_call' && value.type !== 'custom_tool_call' && value.type !== 'tool_search_call') || typeof value.call_id !== 'string') continue;
    const outputType = value.type === 'function_call' ? 'function_call_output' : value.type === 'custom_tool_call' ? 'custom_tool_call_output' : 'tool_search_output';
    if (input.slice(index + 1).some((next) => next && typeof next === 'object'
      && (next as Record<string, unknown>).type === outputType && (next as Record<string, unknown>).call_id === value.call_id)) {
      inlineCallIndexes.add(index);
    }
  }
  type Classified = { kind: 'echo' } | { kind: 'item'; item: InputItem };
  const classified: Classified[] = [];
  for (const [index, item] of input.entries()) {
    if (!item || typeof item !== 'object') return undefined;
    const value = item as Record<string, unknown>;
    if (value.type === 'function_call' && inlineCallIndexes.has(index)
      && typeof value.call_id === 'string' && typeof value.name === 'string' && typeof value.arguments === 'string') {
      classified.push({ kind: 'item', item: { type: 'function_call', call_id: value.call_id, name: value.name, arguments: value.arguments } });
      continue;
    }
    if (value.type === 'custom_tool_call' && inlineCallIndexes.has(index)
      && typeof value.call_id === 'string' && typeof value.name === 'string' && typeof value.input === 'string') {
      classified.push({ kind: 'item', item: { type: 'custom_tool_call', call_id: value.call_id, name: value.name, input: value.input } });
      continue;
    }
    if (value.type === 'tool_search_call' && inlineCallIndexes.has(index)
      && typeof value.call_id === 'string' && typeof value.arguments === 'string') {
      classified.push({ kind: 'item', item: { type: 'tool_search_call', call_id: value.call_id, arguments: value.arguments } });
      continue;
    }
    if (typeof value.type === 'string' && INPUT_ECHO_TYPES.has(value.type)) {
      classified.push({ kind: 'echo' });
      continue;
    }
    if (value.type === 'message' && (value.role === 'user' || value.role === 'assistant' || value.role === 'system' || value.role === 'developer') && Array.isArray(value.content)) {
      const content = normalizeMessageContent(value.content, value.role);
      if (!content) return undefined;
      classified.push({ kind: 'item', item: { type: 'message', role: value.role, content, ...(typeof value.id === 'string' ? { id: value.id } : {}) } });
      continue;
    }
    if (value.type === 'tool_search_output') {
      if (typeof value.call_id !== 'string') return undefined;
      const tools = normalizeTools(value.tools);
      if (!tools) return undefined;
      classified.push({ kind: 'item', item: { type: 'tool_search_output', call_id: value.call_id, tools } });
      continue;
    }
    if ((value.type !== 'function_call_output' && value.type !== 'custom_tool_call_output') || typeof value.call_id !== 'string' || typeof value.output !== 'string') return undefined;
    classified.push({ kind: 'item', item: { type: value.type, call_id: value.call_id, output: value.output } });
  }
  // store:false clients may echo prior output items; keep only the suffix after the last echo.
  let start = 0;
  for (let index = 0; index < classified.length; index += 1) {
    if (classified[index]!.kind === 'echo') start = index + 1;
  }
  const items = classified.slice(start).flatMap((entry) => entry.kind === 'item' ? [entry.item] : []);
  return items.length ? items : undefined;
};

const normalizeMessageContent = (content: unknown[], role: 'user' | 'assistant' | 'system' | 'developer'): string | ChatContentPart[] | undefined => {
  if (!content.length) return role === 'assistant' ? [] : undefined;
  const parts: ChatContentPart[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') return undefined;
    const value = part as Record<string, unknown>;
    if ((value.type === 'input_text' || (value.type === 'output_text' && role === 'assistant')) && typeof value.text === 'string') {
      parts.push({ type: 'text', text: value.text });
      continue;
    }
    if (value.type === 'refusal' && role === 'assistant' && typeof value.refusal === 'string') {
      parts.push({ type: 'refusal', refusal: value.refusal });
      continue;
    }
    if (value.type === 'input_image' && role === 'user' && typeof value.image_url === 'string'
      && (value.detail === undefined || typeof value.detail === 'string')) {
      parts.push({ type: 'image_url', image_url: { url: value.image_url, ...(typeof value.detail === 'string' ? { detail: value.detail } : {}) } });
      continue;
    }
    if (value.type === 'input_file' && role === 'user'
      && (value.file_id === undefined || typeof value.file_id === 'string')
      && (value.filename === undefined || typeof value.filename === 'string')
      && (value.file_data === undefined || typeof value.file_data === 'string')
      && (typeof value.file_id === 'string' || typeof value.filename === 'string' || typeof value.file_data === 'string')) {
      parts.push({ type: 'file', file: {
        ...(typeof value.file_id === 'string' ? { file_id: value.file_id } : {}),
        ...(typeof value.filename === 'string' ? { filename: value.filename } : {}),
        ...(typeof value.file_data === 'string' ? { file_data: value.file_data } : {}),
      } });
      continue;
    }
    const audio = value.input_audio;
    if (value.type === 'input_audio' && role === 'user' && audio && typeof audio === 'object'
      && typeof (audio as Record<string, unknown>).data === 'string' && typeof (audio as Record<string, unknown>).format === 'string') {
      parts.push({ type: 'input_audio', input_audio: { data: String((audio as Record<string, unknown>).data), format: String((audio as Record<string, unknown>).format) } });
      continue;
    }
    return undefined;
  }
  return parts.every((part) => part.type === 'text') ? parts.map((part) => (part as { text: string }).text).join('') : parts;
};

export const TOOL_NAME_MAX = 64;
export const ALIAS_HASH_LEN = 16;

export const normalizeFunctionTool = (value: Record<string, unknown>): FunctionTool | undefined => {
  const nested = value.function;
  const fn = nested && typeof nested === 'object' && !Array.isArray(nested) ? nested as Record<string, unknown> : undefined;
  const name = fn && typeof fn.name === 'string' ? fn.name : (typeof value.name === 'string' ? value.name : undefined);
  if (typeof name !== 'string' || name.length === 0) return undefined;
  const description = fn ? fn.description : value.description;
  const parameters = fn ? fn.parameters : value.parameters;
  const strict = fn && fn.strict !== undefined ? fn.strict : value.strict;
  if (description !== undefined && typeof description !== 'string') return undefined;
  if (strict !== undefined && typeof strict !== 'boolean') return undefined;
  return {
    type: 'function', name,
    ...(typeof description === 'string' ? { description } : {}),
    ...(parameters !== undefined ? { parameters } : {}),
    ...(typeof strict === 'boolean' ? { strict } : {}),
  };
};

// Function Tool Schema Normalization: the persisted Tool Context keeps the original
// downstream `parameters` untouched, but the Chat proxy payload must always carry an
// object JSON Schema so strict OpenAI-compatible upstreams accept the tool.
export const normalizeChatFunctionParameters = (parameters: unknown): Record<string, unknown> => {
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
    return { type: 'object', properties: {} };
  }
  const normalized: Record<string, unknown> = { ...(parameters as Record<string, unknown>) };
  if (normalized.type !== 'object') normalized.type = 'object';
  return normalized;
};

export const normalizeTools = (tools: unknown): Tool[] | undefined => {
  if (tools === undefined) return undefined;
  if (!Array.isArray(tools)) return undefined;
  const normalized: Tool[] = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') return undefined;
    const value = tool as Record<string, unknown>;
    if (value.type === 'web_search') {
      normalized.push({ type: 'web_search' });
      continue;
    }
    if (value.type === 'namespace') {
      if (typeof value.name !== 'string' || value.name.length === 0) return undefined;
      if (typeof value.description !== 'string') return undefined;
      if (!Array.isArray(value.tools)) return undefined;
      const children: FunctionTool[] = [];
      const seenChildren = new Set<string>();
      for (const child of value.tools) {
        if (!child || typeof child !== 'object') return undefined;
        const childValue = child as Record<string, unknown>;
        if (childValue.type !== 'function') return undefined;
        const normalizedChild = normalizeFunctionTool(childValue);
        if (!normalizedChild) return undefined;
        if (seenChildren.has(normalizedChild.name)) return undefined;
        seenChildren.add(normalizedChild.name);
        children.push(normalizedChild);
      }
      normalized.push({ type: 'namespace', name: value.name, description: value.description, tools: children });
      continue;
    }
    if (value.type === 'function') {
      const normalizedFunction = normalizeFunctionTool(value);
      if (!normalizedFunction) return undefined;
      normalized.push(normalizedFunction);
      continue;
    }
    if (value.type === 'custom') {
      if (typeof value.name !== 'string' || value.name.length === 0) return undefined;
      if (value.description !== undefined && typeof value.description !== 'string') return undefined;
      normalized.push({
        type: 'custom', name: value.name,
        ...(typeof value.description === 'string' ? { description: value.description } : {}),
        ...(value.format === undefined ? {} : { format: value.format }),
      });
      continue;
    }
    if (value.type === 'tool_search') {
      // Tool Search is a client-executed discovery protocol proxied as a fixed Chat function;
      // only the optional description is preserved. execution is never stored: this bridge
      // always proxies tool_search as client-executed and restores execution:'client'.
      if (value.description !== undefined && value.description !== null && typeof value.description !== 'string') return undefined;
      normalized.push({ type: 'tool_search', ...(typeof value.description === 'string' ? { description: value.description } : {}) });
      continue;
    }
    return undefined;
  }
  return normalized;
};


// Tool Namespace alias mirrors CC Switch's flatten_namespace_tool_name: the Chat
// function name is `namespace__name`; only names exceeding the 64-byte limit are
// truncated and suffixed with a short SHA-256 hash so overlong aliases stay unique.
export const namespaceToolAlias = (namespace: string, name: string) => {
  const fullName = `${namespace}__${name}`;
  if (Buffer.byteLength(fullName, 'utf8') <= TOOL_NAME_MAX) return fullName;
  const hash = createHash('sha256').update(fullName).digest('hex').slice(0, ALIAS_HASH_LEN);
  const suffix = `__${hash}`;
  const prefixLen = TOOL_NAME_MAX - Buffer.byteLength(suffix, 'utf8');
  let prefix = '';
  let used = 0;
  for (const ch of fullName) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (used + size > prefixLen) break;
    used += size;
    prefix += ch;
  }
  return `${prefix}${suffix}`;
};

// Tool Context: the reversible mapping from the Chat function names actually sent to
// the Completion upstream back to the original Function, Custom or Namespace semantics.
// Custom Tools proxy as plain Chat functions carrying their own name, so the context only
// needs to remember which function names are Custom proxies; it is rebuilt from the
// persisted Response tools during continuation rather than from the current request.
export const buildToolContext = (tools: Tool[]) => {
  const reserved = new Set<string>();
  const customNames = new Set<string>();
  const toolSearchNames = new Set<string>();
  for (const tool of tools) {
    if (tool.type === 'tool_search') {
      // Tool Search proxies as the fixed `tool_search` Chat function, so that name is
      // reserved and a client Function/Custom named `tool_search` would collide on reverse.
      if (toolSearchNames.has(TOOL_SEARCH_PROXY_NAME) || reserved.has(TOOL_SEARCH_PROXY_NAME) || customNames.has(TOOL_SEARCH_PROXY_NAME)) throw new Error('Tool name conflict');
      toolSearchNames.add(TOOL_SEARCH_PROXY_NAME);
      continue;
    }
    if (tool.type !== 'function' && tool.type !== 'custom') continue;
    if (reserved.has(tool.name) || customNames.has(tool.name) || toolSearchNames.has(tool.name)) throw new Error('Tool name conflict');
    if (tool.type === 'custom') customNames.add(tool.name);
    else reserved.add(tool.name);
  }
  const aliasToRef = new Map<string, { name: string; namespace: string }>();
  const refToAlias = new Map<string, string>();
  for (const tool of tools) {
    if (tool.type !== 'namespace') continue;
    for (const child of tool.tools) {
      const key = `${tool.name}\0${child.name}`;
      if (refToAlias.has(key)) throw new Error('Tool Namespace alias conflict');
      const alias = namespaceToolAlias(tool.name, child.name);
      if (reserved.has(alias) || customNames.has(alias) || toolSearchNames.has(alias)) throw new Error('Tool Namespace alias conflict');
      reserved.add(alias);
      aliasToRef.set(alias, { name: child.name, namespace: tool.name });
      refToAlias.set(key, alias);
    }
  }
  return { aliasToRef, refToAlias, customNames, toolSearchNames };
};

// Custom Tool proxy description embeds the original Custom tool definition so the model
// observes the original semantics while the upstream only sees a Function tool.
export const buildCustomProxyDescription = (tool: CustomTool): string => {
  const original: Record<string, unknown> = { type: 'custom', name: tool.name };
  if (tool.description !== undefined) original.description = tool.description;
  if (tool.format !== undefined) original.format = tool.format;
  return JSON.stringify(original);
};

// Custom Tool proxy parameters: a single required string `input` carrying the free-form
// Custom input. The schema is fixed regardless of the original `format`.
export const CUSTOM_PROXY_PARAMETERS = { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] };

// Tool Search proxies as a fixed Chat function named `tool_search` with an empty object
// parameter schema (the Responses client-executed tool_search carries EmptyModelParam).
export const TOOL_SEARCH_PROXY_NAME = 'tool_search';
export const TOOL_SEARCH_PROXY_PARAMETERS = { type: 'object', properties: {} };

// Tool Search output is the loaded tool definitions; they are serialized into the Chat
// `tool` message content so the upstream model observes what the discovery returned. The
// same tools are also placed in the Chat `tools` array so they can be called directly.
export const toolSearchOutputContent = (tools: Tool[]) => JSON.stringify(tools);

// Reverse conversion prefers `{ input: string }`; empty, non-JSON, non-object, missing
// or non-string input falls back to the raw arguments so free-form input is never lost.
export const extractCustomInput = (args: string): string => {
  let parsed: unknown;
  try { parsed = JSON.parse(args); } catch { return args; }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return args;
  const input = (parsed as Record<string, unknown>).input;
  return typeof input === 'string' ? input : args;
};

export const toChatTools = (tools: Tool[]) => {
  const { refToAlias } = buildToolContext(tools);
  const chatTools: Array<{ type: 'function'; function: { name: string; description?: string; parameters?: unknown; strict?: boolean } }> = [];
  for (const tool of tools) {
    if (tool.type === 'web_search') continue;
    if (tool.type === 'namespace') {
      for (const child of tool.tools) {
        const alias = refToAlias.get(`${tool.name}\0${child.name}`);
        if (!alias) throw new Error('Tool Namespace alias missing');
        chatTools.push({
          type: 'function',
          function: {
            name: alias,
            ...(child.description === undefined ? {} : { description: child.description }),
            parameters: normalizeChatFunctionParameters(child.parameters),
            ...(child.strict === undefined ? {} : { strict: child.strict }),
          },
        });
      }
      continue;
    }
    if (tool.type === 'tool_search') {
      // Tool Search proxied as the fixed `tool_search` Chat function; the optional
      // client description is passed through so the model knows when to discover tools.
      chatTools.push({
        type: 'function',
        function: {
          name: TOOL_SEARCH_PROXY_NAME,
          ...(tool.description === undefined ? {} : { description: tool.description }),
          parameters: TOOL_SEARCH_PROXY_PARAMETERS,
        },
      });
      continue;
    }
    if (tool.type === 'function') {
      chatTools.push({
        type: 'function',
        function: {
          name: tool.name,
          ...(tool.description === undefined ? {} : { description: tool.description }),
          parameters: normalizeChatFunctionParameters(tool.parameters),
          ...(tool.strict === undefined ? {} : { strict: tool.strict }),
        },
      });
    } else {
      // Custom Tool proxied as a Function with a single required string `input`;
      // the original Custom definition is embedded in the description.
      chatTools.push({
        type: 'function',
        function: {
          name: tool.name,
          description: buildCustomProxyDescription(tool),
          parameters: CUSTOM_PROXY_PARAMETERS,
        },
      });
    }
  }
  return chatTools;
};

export const toChatToolChoice = (toolChoice: unknown, tools: Tool[]) => {
  if (!toolChoice || typeof toolChoice !== 'object') return undefined;
  const value = toolChoice as Record<string, unknown>;
  if (value.type !== 'function' || typeof value.name !== 'string') return undefined;
  if (typeof value.namespace === 'string') {
    const alias = buildToolContext(tools).refToAlias.get(`${value.namespace}\0${value.name}`);
    if (!alias) return null;
    return { type: 'function' as const, function: { name: alias } };
  }
  return { type: 'function' as const, function: { name: value.name } };
};

export const WEB_SEARCH_UNAVAILABLE_HINT = 'Hosted web search is unavailable on this upstream. Do not claim you performed a live web search, cite live results, or invent search calls.';

export const toChatMessages = (response: StoredResponse): ChatMessage[] => {
  // The Tool Context for this Response is the declared tools plus any tools dynamically
  // loaded by tool_search_output items in its own input; both are persisted, so the
  // alias map is rebuilt from them rather than from the current request tools.
  const loadedTools = response.input
    .filter((item): item is Extract<InputItem, { type: 'tool_search_output' }> => item.type === 'tool_search_output')
    .flatMap((item) => item.tools);
  const { refToAlias } = buildToolContext([...response.tools, ...loadedTools]);
  const messages: ChatMessage[] = response.input.flatMap((item): ChatMessage[] => {
    if (item.type === 'message') return [{ role: item.role === 'developer' || item.role === 'system' ? 'system' : item.role, content: item.content }];
    if (item.type === 'function_call') return [{
      role: 'assistant', tool_calls: [{ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } }],
    }];
    if (item.type === 'custom_tool_call') return [{
      role: 'assistant', tool_calls: [{ id: item.call_id, type: 'function', function: { name: item.name, arguments: JSON.stringify({ input: item.input }) } }],
    }];
    if (item.type === 'tool_search_call') return [{
      role: 'assistant', tool_calls: [{ id: item.call_id, type: 'function', function: { name: TOOL_SEARCH_PROXY_NAME, arguments: item.arguments } }],
    }];
    if (item.type === 'tool_search_output') return [{
      role: 'tool', tool_call_id: item.call_id, content: toolSearchOutputContent(item.tools),
    }];
    return [{ role: 'tool', tool_call_id: item.call_id, content: item.output }];
  });
  const toolCalls = response.output.filter((item): item is Extract<OutputItem, { type: 'function_call' | 'custom_tool_call' | 'tool_search_call' }> => item.type === 'function_call' || item.type === 'custom_tool_call' || item.type === 'tool_search_call');
  const text = response.output.find((item): item is Extract<OutputItem, { type: 'message' }> => item.type === 'message');
  if (text || toolCalls.length) {
    messages.push({
      role: 'assistant',
      ...(text ? { content: text.content.map((part) => part.text).join('') } : {}),
      ...(toolCalls.length ? { tool_calls: toolCalls.map((item): ChatToolCall => {
        if (item.type === 'custom_tool_call') {
          return { id: item.call_id, type: 'function', function: { name: item.name, arguments: JSON.stringify({ input: item.input }) } };
        }
        if (item.type === 'tool_search_call') {
          return { id: item.call_id, type: 'function', function: { name: TOOL_SEARCH_PROXY_NAME, arguments: item.arguments } };
        }
        const alias = item.namespace ? refToAlias.get(`${item.namespace}\0${item.name}`) : undefined;
        if (item.namespace && !alias) throw new Error('Tool Namespace alias missing');
        return {
          id: item.call_id, type: 'function',
          function: { name: alias ?? item.name, arguments: item.arguments },
        };
      }) } : {}),
    });
  }
  return messages;
};

export const REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
export const parseReasoningEffort = (reasoning: unknown): string | undefined | null => {
  if (reasoning === undefined || reasoning === null) return undefined;
  if (typeof reasoning === 'string') return REASONING_EFFORTS.has(reasoning) ? reasoning : null;
  if (typeof reasoning !== 'object' || Array.isArray(reasoning)) return null;
  const effort = (reasoning as { effort?: unknown }).effort;
  if (effort === undefined) return undefined;
  return typeof effort === 'string' && REASONING_EFFORTS.has(effort) ? effort : null;
};

export type ToolContext = ReturnType<typeof buildToolContext>;
type UpstreamToolCall = { index?: unknown; id?: unknown; type?: unknown; function?: { name?: unknown; arguments?: unknown } };
type UpstreamChunk = { choices?: Array<{ delta?: { content?: unknown; tool_calls?: UpstreamToolCall[] }; finish_reason?: unknown }>; usage?: unknown };

const usageNumber = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : 0;
export const toResponsesUsage = (usage: unknown): ResponsesUsage => {
  const source = usage && typeof usage === 'object' ? usage as Record<string, unknown> : {};
  const inputDetails = source.prompt_tokens_details && typeof source.prompt_tokens_details === 'object' ? source.prompt_tokens_details as Record<string, unknown> : {};
  const outputDetails = source.completion_tokens_details && typeof source.completion_tokens_details === 'object' ? source.completion_tokens_details as Record<string, unknown> : {};
  const cacheCreationTokens = usageNumber(inputDetails.cache_creation_tokens ?? source.cache_creation_input_tokens);
  const inputTokens = usageNumber(source.prompt_tokens ?? source.input_tokens);
  const outputTokens = usageNumber(source.completion_tokens ?? source.output_tokens);
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: usageNumber(source.total_tokens) || (inputTokens + outputTokens),
    input_tokens_details: {
      cached_tokens: usageNumber(inputDetails.cached_tokens ?? source.cache_read_input_tokens),
      ...(cacheCreationTokens ? { cache_creation_tokens: cacheCreationTokens } : {}),
    },
    output_tokens_details: { reasoning_tokens: usageNumber(outputDetails.reasoning_tokens ?? source.reasoning_tokens) },
  };
};

export class StreamTranslator {
  outputStarted = false;
  outputText = '';
  output: OutputItem[] = [];
  usage: ResponsesUsage = toResponsesUsage(undefined);
  finishReason: 'completed' | 'incomplete' | undefined;
  #nextOutputIndex = 0;
  #textOutputIndex: number | undefined;
  #calls = new Map<number, { id?: string; name?: string; kind: 'function' | 'custom' | 'tool_search'; input: string; outputIndex: number }>();
  #id: string;
  #toolContext: ToolContext;

  constructor(id: string, toolContext: ToolContext) {
    this.#id = id;
    this.#toolContext = toolContext;
  }

  feed(data: string): ResponseEvent[] {
    const chunk = JSON.parse(data) as UpstreamChunk;
    const delta = chunk.choices?.[0]?.delta;
    const events: ResponseEvent[] = [];
    if (chunk.usage !== undefined) this.usage = toResponsesUsage(chunk.usage);
    if (chunk.choices?.some((choice) => choice.finish_reason !== undefined && choice.finish_reason !== null)) {
      this.finishReason = chunk.choices.some((choice) => choice.finish_reason === 'length') ? 'incomplete' : 'completed';
    }
    if (typeof delta?.content === 'string' && delta.content.length) {
      if (this.#textOutputIndex === undefined) {
        this.#textOutputIndex = this.#nextOutputIndex++;
        events.push({
          type: 'response.output_item.added', output_index: this.#textOutputIndex,
          item: { id: `msg_${this.#id}`, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
        });
      }
      this.outputStarted = true;
      this.outputText += delta.content;
      events.push({ type: 'response.output_text.delta', item_id: `msg_${this.#id}`, output_index: this.#textOutputIndex, content_index: 0, delta: delta.content });
    }
    for (const call of delta?.tool_calls ?? []) {
      if (!Number.isInteger(call.index) || Number(call.index) < 0) throw new Error('Invalid upstream Tool call');
      // Custom Tools proxy as Chat functions, so the upstream only emits function calls;
      // the Tool Context (customNames) restores Custom semantics on the reverse path.
      if (call.type !== undefined && call.type !== 'function') throw new Error('Invalid upstream Tool call');
      const index = Number(call.index);
      const isNew = !this.#calls.has(index);
      if (isNew) {
        const initialName = typeof call.function?.name === 'string' ? call.function.name : undefined;
        const kind = initialName && this.#toolContext.toolSearchNames.has(initialName) ? 'tool_search'
          : initialName && this.#toolContext.customNames.has(initialName) ? 'custom'
          : 'function';
        this.#calls.set(index, { kind, input: '', outputIndex: index + (this.#textOutputIndex === undefined ? 0 : 1) });
      }
      const current = this.#calls.get(index)!;
      this.#nextOutputIndex = Math.max(this.#nextOutputIndex, current.outputIndex + 1);
      if (typeof call.id === 'string') current.id = call.id;
      if (typeof call.function?.name === 'string') current.name = call.function.name;
      if (isNew) {
        events.push({
          type: 'response.output_item.added', output_index: current.outputIndex,
          item: { id: current.id ?? `tc_${index}`, type: current.kind === 'function' ? 'function_call' : current.kind === 'custom' ? 'custom_tool_call' : 'tool_search_call', status: 'in_progress' },
        });
      }
      const inputDelta = call.function?.arguments;
      if (typeof inputDelta === 'string') {
        this.outputStarted = true;
        current.input += inputDelta;
        // Custom proxy arguments are the `{ input: string }` transport envelope; only the
        // final extracted input is exposed, so no input delta is streamed for Custom calls.
        if (current.kind === 'function') {
          events.push({
            type: 'response.function_call_arguments.delta',
            item_id: current.id ?? `tc_${index}`, output_index: current.outputIndex, delta: inputDelta,
          });
        }
      }
    }
    return events;
  }

  finalize(): ResponseEvent[] {
    const events: ResponseEvent[] = [];
    const orderedOutput: Array<{ index: number; item: OutputItem }> = [];
    if (this.outputText && this.#textOutputIndex !== undefined) orderedOutput.push({
      index: this.#textOutputIndex,
      item: { id: `msg_${this.#id}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: this.outputText }] },
    });
    for (const [index, call] of [...this.#calls.entries()].sort(([left], [right]) => left - right)) {
      if (!call.id || !call.name) throw new Error('Incomplete upstream Tool call');
      if (call.kind === 'tool_search') {
        // Tool Search has no dedicated argument delta/done event in the Responses SSE
        // lifecycle, so only the completed tool_search_call item is emitted.
        orderedOutput.push({
          index: call.outputIndex,
          item: { id: call.id, type: 'tool_search_call', status: 'completed', call_id: call.id, execution: 'client', arguments: call.input },
        });
        continue;
      }
      const resolved = call.kind === 'function' ? this.#toolContext.aliasToRef.get(call.name) : undefined;
      orderedOutput.push({
        index: call.outputIndex,
        item: call.kind === 'function'
          ? {
            id: call.id, type: 'function_call', status: 'completed', call_id: call.id,
            name: resolved?.name ?? call.name, arguments: call.input,
            ...(resolved ? { namespace: resolved.namespace } : {}),
          }
          : { id: call.id, type: 'custom_tool_call', status: 'completed', call_id: call.id, name: call.name, input: extractCustomInput(call.input) },
      });
      events.push(call.kind === 'function'
        ? { type: 'response.function_call_arguments.done', item_id: call.id, output_index: call.outputIndex, arguments: call.input }
        : { type: 'response.custom_tool_call_input.done', item_id: call.id, output_index: call.outputIndex, input: extractCustomInput(call.input) });
    }
    this.output = orderedOutput.sort((left, right) => left.index - right.index).map(({ item }) => item);
    for (const [index, item] of this.output.entries()) {
      events.push({ type: 'response.output_item.done', output_index: index, item });
    }
    return events;
  }
}

type BuiltRequest = { upstreamBody: Record<string, unknown>; toolContext: ToolContext; model: string };

export const buildChatRequest = (payload: ResponsesPayload, effectiveTools: Tool[], ancestors: StoredResponse[], input: InputItem[], degradeWebSearch: boolean, reasoningEffort: string | undefined): Result<BuiltRequest> => {
  let chatTools: ReturnType<typeof toChatTools>;
  let toolContext: ReturnType<typeof buildToolContext>;
  let chatToolChoice: ReturnType<typeof toChatToolChoice> | 'auto' | undefined;
  let hasChatTools = false;
  try {
    chatTools = toChatTools(effectiveTools);
    toolContext = buildToolContext(effectiveTools);
    const forcedWebSearchChoice = payload.tool_choice !== undefined && typeof payload.tool_choice === 'object' && payload.tool_choice !== null
      && (payload.tool_choice as { type?: unknown }).type === 'web_search';
    const mappedToolChoice = toChatToolChoice(payload.tool_choice, effectiveTools);
    if (mappedToolChoice === null) {
      return { ok: false, error: { status: 400, message: 'tool_choice targets an unknown Tool Namespace function', code: 'unsupported_tools' } };
    }
    hasChatTools = chatTools.length > 0;
    const forcedWebSearchDegrade = degradeWebSearch && forcedWebSearchChoice;
    // Without Chat tools, tool_choice and parallel_tool_calls are no longer valid
    // and strict upstreams reject them; drop both regardless of the client request.
    chatToolChoice = !hasChatTools ? undefined
      : forcedWebSearchDegrade ? 'auto'
      : mappedToolChoice;
  } catch (error) {
    return { ok: false, error: { status: 400, message: error instanceof Error ? error.message : 'Tool name conflict', code: 'unsupported_tools' } };
  }
  const rawMessages: ChatMessage[] = [
    ...(degradeWebSearch ? [{ role: 'system' as const, content: WEB_SEARCH_UNAVAILABLE_HINT }] : []),
    ...ancestors.flatMap(toChatMessages),
    ...toChatMessages({ id: '', model: '', input, tools: [], parallelToolCalls: false, output: [] }),
  ];
  const instructions = typeof payload.instructions === 'string' && payload.instructions.length ? payload.instructions : undefined;
  const systemPrefix = rawMessages.filter((message): message is Extract<ChatMessage, { role: 'system' }> => message.role === 'system');
  const messages: ChatMessage[] = [
    ...(instructions || systemPrefix.length ? [{ role: 'system' as const, content: [instructions, ...systemPrefix.map(({ content }) => typeof content === 'string' ? content : '')].filter(Boolean).join('\n') }] : []),
    ...rawMessages.filter((message) => message.role !== 'system'),
  ];
  const model = typeof payload.model === 'string' ? payload.model : 'gpt-4.1';
  const parallelToolCalls = hasChatTools
    && (payload.parallel_tool_calls === true || ancestors.some((item) => item.parallelToolCalls));
  const stream = payload.stream === true;
  const explicitCeiling = payload.max_completion_tokens ?? payload.max_tokens;
  const maxOutputTokens = explicitCeiling ?? payload.max_output_tokens;
  const ceilingKey = payload.max_completion_tokens !== undefined ? 'max_completion_tokens'
    : payload.max_tokens !== undefined ? 'max_tokens'
      : /^o(?:\d|[-_])/i.test(model) ? 'max_completion_tokens' : 'max_tokens';
  const controls = Object.fromEntries([
    'temperature', 'top_p', 'presence_penalty', 'frequency_penalty', 'logit_bias', 'logprobs', 'top_logprobs', 'seed', 'stop', 'response_format', 'n', 'user',
  ].flatMap((key) => payload[key as keyof ResponsesPayload] === undefined ? [] : [[key, payload[key as keyof ResponsesPayload]]]));
  const upstreamBody: Record<string, unknown> = {
    model, stream, messages,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    ...(maxOutputTokens === undefined ? {} : { [ceilingKey]: maxOutputTokens }),
    ...controls,
    ...(chatTools.length ? { tools: chatTools } : {}),
    ...(parallelToolCalls ? { parallel_tool_calls: true } : {}),
    ...(chatToolChoice === undefined ? {} : { tool_choice: chatToolChoice }),
    ...(reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort }),
  };
  return { ok: true, value: { upstreamBody, toolContext, model } };
};

import { createHash } from 'node:crypto';
import type { ChatContentPart, ChatMessage, ChatToolCall, FunctionTool, InputItem, OutputItem, ResponseEvent, ResponsesPayload, ResponsesUsage, Result, StoredResponse, Tool } from './types.js';

export const INPUT_ECHO_TYPES = new Set(['function_call', 'custom_tool_call', 'web_search_call', 'reasoning']);

export const normalizeInput = (input: unknown): InputItem[] | undefined => {
  if (typeof input === 'string' && input.length > 0) return [{ type: 'message', role: 'user', content: input }];
  if (!Array.isArray(input) || input.length === 0) return undefined;
  const inlineCallIndexes = new Set<number>();
  for (let index = 0; index < input.length; index += 1) {
    const item = input[index];
    if (!item || typeof item !== 'object') continue;
    const value = item as Record<string, unknown>;
    if ((value.type !== 'function_call' && value.type !== 'custom_tool_call') || typeof value.call_id !== 'string') continue;
    const outputType = value.type === 'function_call' ? 'function_call_output' : 'custom_tool_call_output';
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
export const ALIAS_HASH_LEN = 8;

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
    return undefined;
  }
  return normalized;
};

export const sanitizeToolNamePart = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '_');

export const namespaceToolAlias = (namespace: string, name: string, reserved: Set<string>) => {
  const hash = createHash('sha256').update(`${namespace}\0${name}`).digest('hex').slice(0, ALIAS_HASH_LEN);
  const readable = sanitizeToolNamePart(`${namespace}_${name}`);
  const maxPrefix = TOOL_NAME_MAX - 1 - hash.length;
  let prefix = readable.slice(0, Math.max(maxPrefix, 0)).replace(/_+$/g, '');
  if (!prefix || !/^[a-zA-Z0-9]/.test(prefix)) prefix = `ns_${prefix}`.slice(0, Math.max(maxPrefix, 2));
  let alias = `${prefix}_${hash}`.slice(0, TOOL_NAME_MAX);
  let n = 0;
  while (reserved.has(alias)) {
    n += 1;
    const suffix = `_${hash}${n}`;
    alias = `${prefix.slice(0, Math.max(TOOL_NAME_MAX - suffix.length, 1))}${suffix}`.slice(0, TOOL_NAME_MAX);
    if (n > 1000) throw new Error('Tool Namespace alias conflict');
  }
  return alias;
};

export const buildNamespaceAliasMaps = (tools: Tool[]) => {
  const reserved = new Set<string>();
  for (const tool of tools) {
    if (tool.type === 'function' || tool.type === 'custom') reserved.add(tool.name);
  }
  const aliasToRef = new Map<string, { name: string; namespace: string }>();
  const refToAlias = new Map<string, string>();
  for (const tool of tools) {
    if (tool.type !== 'namespace') continue;
    for (const child of tool.tools) {
      const key = `${tool.name}\0${child.name}`;
      if (refToAlias.has(key)) throw new Error('Tool Namespace alias conflict');
      const alias = namespaceToolAlias(tool.name, child.name, reserved);
      reserved.add(alias);
      aliasToRef.set(alias, { name: child.name, namespace: tool.name });
      refToAlias.set(key, alias);
    }
  }
  return { aliasToRef, refToAlias };
};

export const toChatTools = (tools: Tool[]) => {
  const { refToAlias } = buildNamespaceAliasMaps(tools);
  const chatTools: Array<
    | { type: 'function'; function: { name: string; description?: string; parameters?: unknown; strict?: boolean } }
    | { type: 'custom'; custom: { name: string; description?: string; format?: unknown } }
  > = [];
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
      chatTools.push({
        type: 'custom',
        custom: {
          name: tool.name,
          ...(tool.description === undefined ? {} : { description: tool.description }),
          ...(tool.format === undefined ? {} : { format: tool.format }),
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
    const alias = buildNamespaceAliasMaps(tools).refToAlias.get(`${value.namespace}\0${value.name}`);
    if (!alias) return null;
    return { type: 'function' as const, function: { name: alias } };
  }
  return { type: 'function' as const, function: { name: value.name } };
};

export const WEB_SEARCH_UNAVAILABLE_HINT = 'Hosted web search is unavailable on this upstream. Do not claim you performed a live web search, cite live results, or invent search calls.';

export const toChatMessages = (response: StoredResponse): ChatMessage[] => {
  const { refToAlias } = buildNamespaceAliasMaps(response.tools);
  const messages: ChatMessage[] = response.input.flatMap((item): ChatMessage[] => {
    if (item.type === 'message') return [{ role: item.role === 'developer' || item.role === 'system' ? 'system' : item.role, content: item.content }];
    if (item.type === 'function_call') return [{
      role: 'assistant', tool_calls: [{ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } }],
    }];
    if (item.type === 'custom_tool_call') return [{
      role: 'assistant', tool_calls: [{ id: item.call_id, type: 'custom', custom: { name: item.name, input: item.input } }],
    }];
    return [{ role: 'tool', tool_call_id: item.call_id, content: item.output }];
  });
  const toolCalls = response.output.filter((item): item is Extract<OutputItem, { type: 'function_call' | 'custom_tool_call' }> => item.type === 'function_call' || item.type === 'custom_tool_call');
  const text = response.output.find((item): item is Extract<OutputItem, { type: 'message' }> => item.type === 'message');
  if (text || toolCalls.length) {
    messages.push({
      role: 'assistant',
      ...(text ? { content: text.content.map((part) => part.text).join('') } : {}),
      ...(toolCalls.length ? { tool_calls: toolCalls.map((item): ChatToolCall => {
        if (item.type !== 'function_call') {
          return { id: item.call_id, type: 'custom', custom: { name: item.name, input: item.input } };
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

export type NamespaceAliases = ReturnType<typeof buildNamespaceAliasMaps>;
type UpstreamToolCall = { index?: unknown; id?: unknown; type?: unknown; function?: { name?: unknown; arguments?: unknown }; custom?: { name?: unknown; input?: unknown } };
type UpstreamChunk = { choices?: Array<{ delta?: { content?: unknown; tool_calls?: UpstreamToolCall[] }; finish_reason?: unknown }>; usage?: unknown };

const usageNumber = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : 0;
export const toResponsesUsage = (usage: unknown): ResponsesUsage => {
  const source = usage && typeof usage === 'object' ? usage as Record<string, unknown> : {};
  const inputDetails = source.prompt_tokens_details && typeof source.prompt_tokens_details === 'object' ? source.prompt_tokens_details as Record<string, unknown> : {};
  const outputDetails = source.completion_tokens_details && typeof source.completion_tokens_details === 'object' ? source.completion_tokens_details as Record<string, unknown> : {};
  const cacheCreationTokens = usageNumber(inputDetails.cache_creation_tokens ?? source.cache_creation_input_tokens);
  return {
    input_tokens: usageNumber(source.prompt_tokens ?? source.input_tokens),
    output_tokens: usageNumber(source.completion_tokens ?? source.output_tokens),
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
  #calls = new Map<number, { id?: string; name?: string; kind: 'function' | 'custom'; input: string; outputIndex: number }>();
  #id: string;
  #aliases: NamespaceAliases;

  constructor(id: string, aliases: NamespaceAliases) {
    this.#id = id;
    this.#aliases = aliases;
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
      if (call.type !== undefined && call.type !== 'function' && call.type !== 'custom') throw new Error('Invalid upstream Tool call');
      const kind = call.type === 'custom' ? 'custom' : 'function';
      const isNew = !this.#calls.has(Number(call.index));
      const current = this.#calls.get(Number(call.index)) ?? {
        kind, input: '', outputIndex: Number(call.index) + (this.#textOutputIndex === undefined ? 0 : 1),
      };
      if (current.kind !== kind) throw new Error('Inconsistent upstream Tool call');
      this.#nextOutputIndex = Math.max(this.#nextOutputIndex, current.outputIndex + 1);
      if (typeof call.id === 'string') current.id = call.id;
      const name = current.kind === 'function' ? call.function?.name : call.custom?.name;
      const inputDelta = current.kind === 'function' ? call.function?.arguments : call.custom?.input;
      if (typeof name === 'string') current.name = name;
      if (isNew) {
        events.push({
          type: 'response.output_item.added', output_index: current.outputIndex,
          item: { id: current.id ?? `tc_${Number(call.index)}`, type: current.kind === 'function' ? 'function_call' : 'custom_tool_call', status: 'in_progress' },
        });
      }
      if (typeof inputDelta === 'string') {
        this.outputStarted = true;
        current.input += inputDelta;
        events.push({
          type: current.kind === 'function' ? 'response.function_call_arguments.delta' : 'response.custom_tool_call_input.delta',
          item_id: current.id ?? `tc_${Number(call.index)}`, output_index: current.outputIndex, delta: inputDelta,
        });
      }
      this.#calls.set(Number(call.index), current);
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
      const resolved = call.kind === 'function' ? this.#aliases.aliasToRef.get(call.name) : undefined;
      orderedOutput.push({
        index: call.outputIndex,
        item: call.kind === 'function'
          ? {
            id: call.id, type: 'function_call', status: 'completed', call_id: call.id,
            name: resolved?.name ?? call.name, arguments: call.input,
            ...(resolved ? { namespace: resolved.namespace } : {}),
          }
          : { id: call.id, type: 'custom_tool_call', status: 'completed', call_id: call.id, name: call.name, input: call.input },
      });
      events.push(call.kind === 'function'
        ? { type: 'response.function_call_arguments.done', item_id: call.id, output_index: call.outputIndex, arguments: call.input }
        : { type: 'response.custom_tool_call_input.done', item_id: call.id, output_index: call.outputIndex, input: call.input });
    }
    this.output = orderedOutput.sort((left, right) => left.index - right.index).map(({ item }) => item);
    for (const [index, item] of this.output.entries()) {
      events.push({ type: 'response.output_item.done', output_index: index, item });
    }
    return events;
  }
}

type BuiltRequest = { upstreamBody: Record<string, unknown>; namespaceAliases: NamespaceAliases; model: string };

export const buildChatRequest = (payload: ResponsesPayload, effectiveTools: Tool[], ancestors: StoredResponse[], input: InputItem[], degradeWebSearch: boolean, reasoningEffort: string | undefined): Result<BuiltRequest> => {
  let chatTools: ReturnType<typeof toChatTools>;
  let namespaceAliases: ReturnType<typeof buildNamespaceAliasMaps>;
  let chatToolChoice: ReturnType<typeof toChatToolChoice> | 'auto' | undefined;
  let hasChatTools = false;
  try {
    chatTools = toChatTools(effectiveTools);
    namespaceAliases = buildNamespaceAliasMaps(effectiveTools);
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
  } catch {
    return { ok: false, error: { status: 400, message: 'Tool Namespace aliases conflict', code: 'unsupported_tools' } };
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
  return { ok: true, value: { upstreamBody, namespaceAliases, model } };
};

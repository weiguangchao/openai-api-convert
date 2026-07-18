import { createHash } from 'node:crypto';
import type { ChatMessage, ChatToolCall, FunctionTool, InputItem, OutputItem, StoredResponse, Tool } from './types.ts';

export const INPUT_ECHO_TYPES = new Set(['function_call', 'custom_tool_call', 'web_search_call', 'reasoning']);

export const normalizeInput = (input: unknown): InputItem[] | undefined => {
  if (typeof input === 'string' && input.length > 0) return [{ type: 'message', role: 'user', content: input }];
  if (!Array.isArray(input) || input.length === 0) return undefined;
  type Classified = { kind: 'echo' } | { kind: 'item'; item: InputItem };
  const classified: Classified[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') return undefined;
    const value = item as Record<string, unknown>;
    if (value.type === 'message' && value.role === 'assistant') {
      classified.push({ kind: 'echo' });
      continue;
    }
    if (typeof value.type === 'string' && INPUT_ECHO_TYPES.has(value.type)) {
      classified.push({ kind: 'echo' });
      continue;
    }
    if (value.type === 'message' && (value.role === 'user' || value.role === 'developer') && Array.isArray(value.content)) {
      const text = value.content.map((part) => {
        if (!part || typeof part !== 'object') return undefined;
        const content = part as Record<string, unknown>;
        return content.type === 'input_text' && typeof content.text === 'string' ? content.text : undefined;
      });
      if (!text.length || text.some((part) => part === undefined)) return undefined;
      classified.push({ kind: 'item', item: { type: 'message', role: value.role, content: text.join('') } });
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

export const TOOL_NAME_MAX = 64;
export const ALIAS_HASH_LEN = 8;

export const normalizeFunctionTool = (value: Record<string, unknown>): FunctionTool | undefined => {
  if (typeof value.name !== 'string' || value.name.length === 0) return undefined;
  if (value.description !== undefined && typeof value.description !== 'string') return undefined;
  if (value.strict !== undefined && typeof value.strict !== 'boolean') return undefined;
  return {
    type: 'function', name: value.name,
    ...(typeof value.description === 'string' ? { description: value.description } : {}),
    ...(value.parameters !== undefined ? { parameters: value.parameters } : {}),
    ...(typeof value.strict === 'boolean' ? { strict: value.strict } : {}),
  };
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
    if ((value.type !== 'function' && value.type !== 'custom') || typeof value.name !== 'string' || value.name.length === 0) return undefined;
    if (value.description !== undefined && typeof value.description !== 'string') return undefined;
    if (value.type === 'function') {
      const normalizedFunction = normalizeFunctionTool(value);
      if (!normalizedFunction) return undefined;
      normalized.push(normalizedFunction);
    } else {
      normalized.push({
        type: 'custom', name: value.name,
        ...(typeof value.description === 'string' ? { description: value.description } : {}),
        ...(value.format === undefined ? {} : { format: value.format }),
      });
    }
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
            ...(child.parameters === undefined ? {} : { parameters: child.parameters }),
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
          ...(tool.parameters === undefined ? {} : { parameters: tool.parameters }),
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
  const messages: ChatMessage[] = response.input.map((item) => item.type === 'message'
    ? { role: item.role === 'developer' ? 'system' : 'user', content: item.content }
    : { role: 'tool', tool_call_id: item.call_id, content: item.output });
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

export const REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
export const parseReasoningEffort = (reasoning: unknown): string | undefined | null => {
  if (reasoning === undefined) return undefined;
  if (typeof reasoning !== 'object' || reasoning === null || Array.isArray(reasoning)) return null;
  const effort = (reasoning as { effort?: unknown }).effort;
  if (effort === undefined) return undefined;
  return typeof effort === 'string' && REASONING_EFFORTS.has(effort) ? effort : null;
};

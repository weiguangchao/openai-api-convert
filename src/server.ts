import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

type Upstream = { baseUrl: string; apiKey: string };
type BridgeOptions = { apiKey: string; upstreams: Upstream[]; statePath: string; port?: number };
type StoredEvent = { sequence: number; type: string };
type ResponseEvent = { type: string; [key: string]: unknown };
type FunctionTool = { type: 'function'; name: string; description?: string; parameters?: unknown };
type InputItem = { type: 'message'; role: 'user'; content: string } | { type: 'function_call_output'; call_id: string; output: string };
type OutputItem =
  | { id: string; type: 'message'; status: 'completed'; role: 'assistant'; content: Array<{ type: 'output_text'; text: string }> }
  | { id: string; type: 'function_call'; status: 'completed'; call_id: string; name: string; arguments: string };
type StoredResponse = { id: string; parentId?: string; model: string; input: InputItem[]; tools: FunctionTool[]; output: OutputItem[] };
type ChatMessage =
  | { role: 'user'; content: string }
  | { role: 'tool'; tool_call_id: string; content: string }
  | { role: 'assistant'; content?: string; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> };

class StateStore {
  #db: DatabaseSync;

  constructor(path: string) {
    try {
      this.#db = new DatabaseSync(path);
      this.#db.exec(`
        CREATE TABLE IF NOT EXISTS responses (
          id TEXT PRIMARY KEY,
          parent_id TEXT,
          status TEXT NOT NULL,
          model TEXT NOT NULL DEFAULT 'gpt-4.1',
          input_json TEXT NOT NULL DEFAULT '[]',
          tools_json TEXT NOT NULL DEFAULT '[]',
          context_complete INTEGER NOT NULL DEFAULT 1,
          output_text TEXT NOT NULL DEFAULT ''
        ) STRICT;
        CREATE TABLE IF NOT EXISTS output_items (
          response_id TEXT NOT NULL,
          output_index INTEGER NOT NULL,
          item_json TEXT NOT NULL,
          PRIMARY KEY (response_id, output_index)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS stream_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          response_id TEXT NOT NULL,
          type TEXT NOT NULL,
          payload TEXT NOT NULL
        ) STRICT;
      `);
      this.#addColumn('parent_id TEXT');
      this.#addColumn("model TEXT NOT NULL DEFAULT 'gpt-4.1'");
      this.#addColumn("input_json TEXT NOT NULL DEFAULT '[]'");
      this.#addColumn("tools_json TEXT NOT NULL DEFAULT '[]'");
      this.#addColumn('context_complete INTEGER NOT NULL DEFAULT 0');
    } catch (error) {
      throw new Error(`State Store is not writable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  #addColumn(definition: string) {
    const name = definition.split(' ')[0];
    const columns = this.#db.prepare('PRAGMA table_info(responses)').all().map((row) => String(row.name));
    if (!columns.includes(name)) this.#db.exec(`ALTER TABLE responses ADD COLUMN ${definition}`);
  }

  createResponse(response: Omit<StoredResponse, 'output'>) {
    this.#db.prepare(
      'INSERT INTO responses (id, parent_id, status, model, input_json, tools_json, context_complete) VALUES (?, ?, ?, ?, ?, ?, 1)',
    ).run(response.id, response.parentId ?? null, 'in_progress', response.model, JSON.stringify(response.input), JSON.stringify(response.tools));
  }

  appendOutputItem(responseId: string, outputIndex: number, item: OutputItem) {
    this.#db.prepare('INSERT INTO output_items (response_id, output_index, item_json) VALUES (?, ?, ?)')
      .run(responseId, outputIndex, JSON.stringify(item));
  }

  appendEvent(responseId: string, event: ResponseEvent): StoredEvent {
    const result = this.#db.prepare(
      'INSERT INTO stream_events (response_id, type, payload) VALUES (?, ?, ?)',
    ).run(responseId, event.type, JSON.stringify(event));
    return { sequence: Number(result.lastInsertRowid), type: event.type };
  }

  terminal(id: string, status: 'completed' | 'failed', outputText: string, event: ResponseEvent): StoredEvent {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#db.prepare('UPDATE responses SET status = ?, output_text = ? WHERE id = ?')
        .run(status, outputText, id);
      const stored = this.appendEvent(id, event);
      this.#db.exec('COMMIT');
      return stored;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  chain(id: string): StoredResponse[] {
    const chain: StoredResponse[] = [];
    const seen = new Set<string>();
    let next: string | undefined = id;
    while (next) {
      if (seen.has(next)) throw new Error('Response Chain is cyclic');
      seen.add(next);
      const row: Record<string, unknown> | undefined = this.#db.prepare(
        'SELECT id, parent_id, status, model, input_json, tools_json, context_complete FROM responses WHERE id = ?',
      ).get(next) as Record<string, unknown> | undefined;
      if (!row) throw new Error('Previous response was not found');
      if (Number(row.context_complete) !== 1) throw new Error('Previous response was not found');
      if (row.status !== 'completed') throw new Error('Previous response was not found');
      const output = this.#db.prepare(
        'SELECT item_json FROM output_items WHERE response_id = ? ORDER BY output_index',
      ).all(next).map((item) => JSON.parse(String(item.item_json)) as OutputItem);
      chain.unshift({
        id: String(row.id),
        parentId: row.parent_id === null ? undefined : String(row.parent_id),
        model: String(row.model),
        input: JSON.parse(String(row.input_json)) as InputItem[],
        tools: JSON.parse(String(row.tools_json)) as FunctionTool[],
        output,
      });
      next = row.parent_id === null ? undefined : String(row.parent_id);
    }
    return chain;
  }

  events(): StoredEvent[] {
    return this.#db.prepare('SELECT sequence, type FROM stream_events ORDER BY sequence')
      .all().map((row) => ({ sequence: Number(row.sequence), type: String(row.type) }));
  }

  responses() {
    return this.#db.prepare('SELECT status, output_text FROM responses ORDER BY rowid')
      .all().map((row) => ({ status: String(row.status), outputText: String(row.output_text) }));
  }

  close() { this.#db.close(); }
}

export type RunningBridge = {
  url: string;
  state: Pick<StateStore, 'events' | 'responses'>;
  close: () => Promise<void>;
};

const sendError = (response: ServerResponse, status: number, message: string, code: string) => {
  response.writeHead(status, { 'content-type': 'application/json', 'x-request-id': randomUUID() });
  response.end(JSON.stringify({ error: { message, type: 'invalid_request_error', param: null, code } }));
};

const readJson = async (request: IncomingMessage): Promise<unknown> => {
  let body = '';
  for await (const chunk of request) body += chunk;
  return JSON.parse(body);
};

const normalizeInput = (input: unknown): InputItem[] | undefined => {
  if (typeof input === 'string' && input.length > 0) return [{ type: 'message', role: 'user', content: input }];
  if (!Array.isArray(input) || input.length === 0) return undefined;
  const items: InputItem[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') return undefined;
    const value = item as Record<string, unknown>;
    if (value.type !== 'function_call_output' || typeof value.call_id !== 'string' || typeof value.output !== 'string') return undefined;
    items.push({ type: 'function_call_output', call_id: value.call_id, output: value.output });
  }
  return items;
};

const normalizeTools = (tools: unknown): FunctionTool[] | undefined => {
  if (tools === undefined) return undefined;
  if (!Array.isArray(tools)) return undefined;
  const normalized: FunctionTool[] = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') return undefined;
    const value = tool as Record<string, unknown>;
    if (value.type !== 'function' || typeof value.name !== 'string' || value.name.length === 0) return undefined;
    if (value.description !== undefined && typeof value.description !== 'string') return undefined;
    normalized.push({
      type: 'function', name: value.name,
      ...(typeof value.description === 'string' ? { description: value.description } : {}),
      ...(value.parameters !== undefined ? { parameters: value.parameters } : {}),
    });
  }
  return normalized;
};

const toChatTools = (tools: FunctionTool[]) => tools.map((tool) => ({
  type: 'function' as const,
  function: {
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    ...(tool.parameters === undefined ? {} : { parameters: tool.parameters }),
  },
}));

const toChatMessages = (response: StoredResponse): ChatMessage[] => {
  const messages: ChatMessage[] = response.input.map((item) => item.type === 'message'
    ? { role: 'user', content: item.content }
    : { role: 'tool', tool_call_id: item.call_id, content: item.output });
  const functionCalls = response.output.filter((item): item is Extract<OutputItem, { type: 'function_call' }> => item.type === 'function_call');
  const text = response.output.find((item): item is Extract<OutputItem, { type: 'message' }> => item.type === 'message');
  if (text || functionCalls.length) {
    messages.push({
      role: 'assistant',
      ...(text ? { content: text.content.map((part) => part.text).join('') } : {}),
      ...(functionCalls.length ? { tool_calls: functionCalls.map((item) => ({
        id: item.call_id, type: 'function' as const, function: { name: item.name, arguments: item.arguments },
      })) } : {}),
    });
  }
  return messages;
};

const sse = (response: ServerResponse, store: StateStore, responseId: string, event: ResponseEvent) => {
  store.appendEvent(responseId, event);
  response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
};

const terminalSse = (response: ServerResponse, store: StateStore, responseId: string, status: 'completed' | 'failed', outputText: string, event: ResponseEvent) => {
  store.terminal(responseId, status, outputText, event);
  response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
};

const parseUpstream = async function* (body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let boundary: RegExpExecArray | null;
    while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
      const frame = buffer.slice(0, boundary.index).replace(/\r/g, '');
      buffer = buffer.slice(boundary.index + boundary[0].length);
      const data = frame.split('\n').find((line) => line.startsWith('data: '))?.slice(6);
      if (data) yield data;
    }
    if (done) break;
  }
};

const assertOptions = (options: BridgeOptions) => {
  if (!options.apiKey.trim()) throw new Error('Bridge API key is required');
  if (!options.upstreams.length) throw new Error('Upstream Pool is required');
  for (const upstream of options.upstreams) {
    try { new URL(upstream.baseUrl); } catch { throw new Error('Upstream Pool contains an invalid URL'); }
    if (!upstream.apiKey.trim()) throw new Error('Upstream Pool contains an empty API key');
  }
};

export const startBridge = async (options: BridgeOptions): Promise<RunningBridge> => {
  assertOptions(options);
  const state = new StateStore(options.statePath);
  let server: Server | undefined;
  try {
    server = createServer(async (request, response) => {
      if (request.method !== 'POST' || request.url !== '/v1/responses') {
        sendError(response, 404, 'Not found', 'not_found');
        return;
      }
      if (request.headers.authorization !== `Bearer ${options.apiKey}`) {
        sendError(response, 401, 'Invalid authentication credentials', 'invalid_api_key');
        return;
      }

      let payload: { stream?: unknown; input?: unknown; model?: unknown; tools?: unknown; previous_response_id?: unknown; parallel_tool_calls?: unknown };
      try { payload = await readJson(request) as typeof payload; }
      catch { sendError(response, 400, 'Invalid JSON body', 'invalid_json'); return; }
      if (payload.stream !== true) {
        sendError(response, 400, 'Only stream: true is supported', 'stream_required');
        return;
      }
      const input = normalizeInput(payload.input);
      if (!input) {
        sendError(response, 400, 'Only text and Function Tool output input are supported', 'unsupported_input');
        return;
      }
      const tools = normalizeTools(payload.tools);
      if (payload.tools !== undefined && !tools) {
        sendError(response, 400, 'Only Function Tools are supported', 'unsupported_tools');
        return;
      }
      if (payload.previous_response_id !== undefined && (typeof payload.previous_response_id !== 'string' || !payload.previous_response_id)) {
        sendError(response, 400, 'previous_response_id must be a string', 'invalid_previous_response_id');
        return;
      }
      if (input.some((item) => item.type === 'function_call_output') && !payload.previous_response_id) {
        sendError(response, 400, 'Function Tool output requires previous_response_id', 'missing_previous_response_id');
        return;
      }

      let ancestors: StoredResponse[] = [];
      if (payload.previous_response_id) {
        try { ancestors = state.chain(payload.previous_response_id); }
        catch { sendError(response, 400, 'Previous response was not found', 'previous_response_not_found'); return; }
      }
      const callIds = new Set((ancestors.at(-1)?.output ?? [])
        .filter((item): item is Extract<OutputItem, { type: 'function_call' }> => item.type === 'function_call')
        .map((item) => item.call_id));
      if (input.some((item) => item.type === 'function_call_output' && !callIds.has(item.call_id))) {
        sendError(response, 400, 'Function Tool call was not found', 'function_call_not_found');
        return;
      }
      const effectiveTools = tools ?? [...ancestors].reverse().find((item) => item.tools.length > 0)?.tools ?? [];
      const messages: ChatMessage[] = [
        ...ancestors.flatMap(toChatMessages),
        ...toChatMessages({ id: '', model: '', input, tools: [], output: [] }),
      ];
      const model = typeof payload.model === 'string' ? payload.model : 'gpt-4.1';
      const upstreamBody: Record<string, unknown> = {
        model, stream: true, stream_options: { include_usage: true }, messages,
        ...(effectiveTools.length ? { tools: toChatTools(effectiveTools) } : {}),
        ...(typeof payload.parallel_tool_calls === 'boolean' ? { parallel_tool_calls: payload.parallel_tool_calls } : {}),
      };

      let upstreamResponse: Response;
      try {
        const upstream = options.upstreams[0];
        upstreamResponse = await fetch(new URL('/v1/chat/completions', upstream.baseUrl), {
          method: 'POST',
          headers: { authorization: `Bearer ${upstream.apiKey}`, 'content-type': 'application/json', accept: 'text/event-stream' },
          body: JSON.stringify(upstreamBody),
        });
      } catch {
        sendError(response, 503, 'Upstream unavailable', 'upstream_unavailable');
        return;
      }
      if (!upstreamResponse.ok || !upstreamResponse.body) {
        sendError(response, 503, 'Upstream unavailable', 'upstream_unavailable');
        return;
      }

      const id = `resp_${randomUUID().replaceAll('-', '')}`;
      state.createResponse({ id, parentId: payload.previous_response_id, model, input, tools: tools ?? [] });
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      sse(response, state, id, { type: 'response.created', response: { id, object: 'response', status: 'in_progress', model, output: [] } });

      let outputText = '';
      let completed = false;
      let nextOutputIndex = 0;
      let textOutputIndex: number | undefined;
      const calls = new Map<number, { id?: string; name?: string; arguments: string; outputIndex: number }>();
      try {
        for await (const data of parseUpstream(upstreamResponse.body)) {
          if (data === '[DONE]') { completed = true; break; }
          const chunk = JSON.parse(data) as { choices?: Array<{ delta?: { content?: unknown; tool_calls?: Array<{ index?: unknown; id?: unknown; function?: { name?: unknown; arguments?: unknown } }> } }> };
          const delta = chunk.choices?.[0]?.delta;
          if (typeof delta?.content === 'string' && delta.content.length) {
            if (textOutputIndex === undefined) textOutputIndex = nextOutputIndex++;
            outputText += delta.content;
            sse(response, state, id, { type: 'response.output_text.delta', item_id: `msg_${id}`, output_index: textOutputIndex, content_index: 0, delta: delta.content });
          }
          for (const call of delta?.tool_calls ?? []) {
            if (!Number.isInteger(call.index) || Number(call.index) < 0) throw new Error('Invalid upstream Function Tool call');
            const current = calls.get(Number(call.index)) ?? {
              arguments: '', outputIndex: Number(call.index) + (textOutputIndex === undefined ? 0 : 1),
            };
            nextOutputIndex = Math.max(nextOutputIndex, current.outputIndex + 1);
            if (typeof call.id === 'string') current.id = call.id;
            if (typeof call.function?.name === 'string') current.name = call.function.name;
            if (typeof call.function?.arguments === 'string') {
              current.arguments += call.function.arguments;
              sse(response, state, id, {
                type: 'response.function_call_arguments.delta', item_id: current.id ?? `fc_${Number(call.index)}`,
                output_index: current.outputIndex, delta: call.function.arguments,
              });
            }
            calls.set(Number(call.index), current);
          }
        }
        if (!completed) throw new Error('Upstream stream ended without [DONE]');
        const orderedOutput: Array<{ index: number; item: OutputItem }> = [];
        if (outputText && textOutputIndex !== undefined) orderedOutput.push({
          index: textOutputIndex,
          item: { id: `msg_${id}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: outputText }] },
        });
        for (const [index, call] of [...calls.entries()].sort(([left], [right]) => left - right)) {
          if (!call.id || !call.name) throw new Error('Incomplete upstream Function Tool call');
          orderedOutput.push({
            index: call.outputIndex,
            item: { id: call.id, type: 'function_call', status: 'completed', call_id: call.id, name: call.name, arguments: call.arguments },
          });
          sse(response, state, id, { type: 'response.function_call_arguments.done', item_id: call.id, output_index: call.outputIndex, arguments: call.arguments });
        }
        const output = orderedOutput.sort((left, right) => left.index - right.index).map(({ item }) => item);
        for (const [index, item] of output.entries()) {
          state.appendOutputItem(id, index, item);
          sse(response, state, id, { type: 'response.output_item.done', output_index: index, item });
        }
        terminalSse(response, state, id, 'completed', outputText, { type: 'response.completed', response: { id, object: 'response', status: 'completed', model, output } });
      } catch {
        terminalSse(response, state, id, 'failed', outputText, { type: 'response.failed', response: { id, object: 'response', status: 'failed' } });
      }
      response.end();
    });
    await new Promise<void>((resolve, reject) => server!.once('error', reject).listen(options.port ?? 0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Bridge did not bind a TCP port');
    return {
      url: `http://127.0.0.1:${address.port}`,
      state,
      close: async () => {
        await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
        state.close();
      },
    };
  } catch (error) {
    server?.close();
    state.close();
    throw error;
  }
};

import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

type Upstream = { baseUrl: string; apiKey: string };
type BridgeOptions = { apiKey: string; upstreams: Upstream[]; statePath: string; port?: number };
type StoredEvent = { sequence: number; type: string };
type ResponseEvent = { type: string; [key: string]: unknown };

class StateStore {
  #db: DatabaseSync;

  constructor(path: string) {
    try {
      this.#db = new DatabaseSync(path);
      this.#db.exec(`
        CREATE TABLE IF NOT EXISTS responses (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          output_text TEXT NOT NULL DEFAULT ''
        ) STRICT;
        CREATE TABLE IF NOT EXISTS stream_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          response_id TEXT NOT NULL,
          type TEXT NOT NULL,
          payload TEXT NOT NULL
        ) STRICT;
      `);
    } catch (error) {
      throw new Error(`State Store is not writable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  createResponse(id: string) {
    this.#db.prepare('INSERT INTO responses (id, status) VALUES (?, ?)').run(id, 'in_progress');
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

const inputText = (input: unknown): string | undefined => typeof input === 'string' && input.length > 0 ? input : undefined;

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

      let payload: { stream?: unknown; input?: unknown; model?: unknown };
      try { payload = await readJson(request) as typeof payload; }
      catch { sendError(response, 400, 'Invalid JSON body', 'invalid_json'); return; }
      if (payload.stream !== true) {
        sendError(response, 400, 'Only stream: true is supported', 'stream_required');
        return;
      }
      const text = inputText(payload.input);
      if (!text) {
        sendError(response, 400, 'Only non-empty text input is supported', 'unsupported_input');
        return;
      }

      const upstream = options.upstreams[0];
      let upstreamResponse: Response;
      try {
        upstreamResponse = await fetch(new URL('/v1/chat/completions', upstream.baseUrl), {
          method: 'POST',
          headers: { authorization: `Bearer ${upstream.apiKey}`, 'content-type': 'application/json', accept: 'text/event-stream' },
          body: JSON.stringify({
            model: typeof payload.model === 'string' ? payload.model : 'gpt-4.1',
            stream: true,
            stream_options: { include_usage: true },
            messages: [{ role: 'user', content: text }],
          }),
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
      const itemId = `msg_${randomUUID().replaceAll('-', '')}`;
      const model = typeof payload.model === 'string' ? payload.model : 'gpt-4.1';
      state.createResponse(id);
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      sse(response, state, id, { type: 'response.created', response: { id, object: 'response', status: 'in_progress', model, output: [] } });

      let outputText = '';
      let completed = false;
      try {
        for await (const data of parseUpstream(upstreamResponse.body)) {
          if (data === '[DONE]') { completed = true; break; }
          const chunk = JSON.parse(data) as { choices?: Array<{ delta?: { content?: unknown } }> };
          const delta = chunk.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta.length) {
            outputText += delta;
            sse(response, state, id, { type: 'response.output_text.delta', item_id: itemId, output_index: 0, content_index: 0, delta });
          }
        }
        if (!completed) throw new Error('Upstream stream ended without [DONE]');
        const item = { id: itemId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: outputText }] };
        sse(response, state, id, { type: 'response.output_item.done', output_index: 0, item });
        terminalSse(response, state, id, 'completed', outputText, { type: 'response.completed', response: { id, object: 'response', status: 'completed', model, output: [item] } });
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

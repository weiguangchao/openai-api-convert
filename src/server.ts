import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export type CapabilityProfile = { functionTools?: boolean; customTools?: boolean; parallelToolCalls?: boolean; webSearch?: boolean };
export type Upstream = { baseUrl: string; apiKey: string; wireApi?: 'chat' | 'responses'; capabilities?: CapabilityProfile };
export type StatePolicy = {
  responseRetentionDays?: number;
  attemptRetentionDays?: number;
  cleanupThresholdBytes?: number;
  hardLimitBytes?: number;
};
export type BridgeOptions = {
  apiKey: string;
  upstreams: Upstream[];
  statePath: string;
  port?: number;
  firstEventTimeoutMs?: number;
  outputIdleTimeoutMs?: number;
  statePolicy?: StatePolicy;
};
type StoredEvent = { sequence: number; type: string };
type ResponseEvent = { type: string; [key: string]: unknown };
type FunctionTool = { type: 'function'; name: string; description?: string; parameters?: unknown };
type CustomTool = { type: 'custom'; name: string; description?: string; format?: unknown };
type WebSearchTool = { type: 'web_search' };
type Tool = FunctionTool | CustomTool | WebSearchTool;
type FunctionToolOutput = { type: 'function_call_output'; call_id: string; output: string };
type CustomToolOutput = { type: 'custom_tool_call_output'; call_id: string; output: string };
type InputMessage = { type: 'message'; role: 'user' | 'developer'; content: string };
type InputItem = InputMessage | FunctionToolOutput | CustomToolOutput;
type OutputItem =
  | { id: string; type: 'message'; status: 'completed'; role: 'assistant'; content: Array<{ type: 'output_text'; text: string }> }
  | { id: string; type: 'function_call'; status: 'completed'; call_id: string; name: string; arguments: string }
  | { id: string; type: 'custom_tool_call'; status: 'completed'; call_id: string; name: string; input: string }
  | { id: string; type: 'web_search_call'; status: string; [key: string]: unknown };
type NativeUpstreamMapping = { baseUrl: string; identity: string; responseId: string };
type StoredResponse = {
  id: string; parentId?: string; model: string; input: InputItem[]; tools: Tool[]; parallelToolCalls: boolean; output: OutputItem[];
  nativeUpstream?: NativeUpstreamMapping;
};
type IdempotencyClaim =
  | { kind: 'created'; responseId: string }
  | { kind: 'reused'; responseId: string }
  | { kind: 'conflict' }
  | { kind: 'capacity_exceeded' };
type AttemptResult = 'completed' | 'failed' | 'cancelled';
type AttemptCompletion = { id: number; result: AttemptResult; preOutputFailure: boolean; errorCode?: string };
type ChatToolCall =
  | { id: string; type: 'function'; function: { name: string; arguments: string } }
  | { id: string; type: 'custom'; custom: { name: string; input: string } };
type ChatMessage =
  | { role: 'user' | 'system'; content: string }
  | { role: 'tool'; tool_call_id: string; content: string }
  | { role: 'assistant'; content?: string; tool_calls?: ChatToolCall[] };

type ResolvedStatePolicy = Required<StatePolicy>;
type StateObservability = {
  bytes: number;
  cleanupRuns: number;
  deletedChains: number;
  reclaimedBytes: number;
  capacityRejections: number;
  lastCleanup?: { startedAt: number; endedAt: number; deletedChains: number; reclaimedBytes: number; failureReason?: 'cleanup_failed' };
};
type Metrics = {
  requests: number;
  failures: number;
  durationMs: number;
  upstreamSwitches: number;
};

const GIB = 1024 ** 3;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const terminalStatuses = new Set(['completed', 'failed', 'cancelled', 'incomplete']);
const defaultStatePolicy: ResolvedStatePolicy = {
  responseRetentionDays: 30,
  attemptRetentionDays: 7,
  cleanupThresholdBytes: 8 * GIB,
  hardLimitBytes: 10 * GIB,
};

const requestIds = new WeakMap<ServerResponse, string>();
const errorCodes = new WeakMap<ServerResponse, string>();

export const log = (level: 'info' | 'error', event: string, fields: {
  requestId?: string | null;
  responseId?: string | null;
  durationMs?: number;
  errorCode?: string | null;
  [key: string]: string | number | null | undefined;
} = {}) => {
  const entry = {
    timestamp: new Date().toISOString(), level, event,
    request_id: fields.requestId ?? null,
    response_id: fields.responseId ?? null,
    duration_ms: fields.durationMs ?? 0,
    error_code: fields.errorCode ?? null,
    ...Object.fromEntries(Object.entries(fields).filter(([key]) => !['requestId', 'responseId', 'durationMs', 'errorCode'].includes(key))),
  };
  console[level](JSON.stringify(entry));
};

const prometheus = (metrics: Metrics, observability: StateObservability) => [
  '# TYPE bridge_requests_total counter', `bridge_requests_total ${metrics.requests}`,
  '# TYPE bridge_request_failures_total counter', `bridge_request_failures_total ${metrics.failures}`,
  '# TYPE bridge_request_duration_seconds_sum counter', `bridge_request_duration_seconds_sum ${metrics.durationMs / 1_000}`,
  '# TYPE bridge_request_duration_seconds_count counter', `bridge_request_duration_seconds_count ${metrics.requests}`,
  '# TYPE bridge_upstream_switches_total counter', `bridge_upstream_switches_total ${metrics.upstreamSwitches}`,
  '# TYPE bridge_state_store_bytes gauge', `bridge_state_store_bytes ${observability.bytes}`,
  '# TYPE bridge_state_store_cleanup_runs_total counter', `bridge_state_store_cleanup_runs_total ${observability.cleanupRuns}`,
  '# TYPE bridge_state_store_deleted_chains_total counter', `bridge_state_store_deleted_chains_total ${observability.deletedChains}`,
  '# TYPE bridge_state_store_reclaimed_bytes_total counter', `bridge_state_store_reclaimed_bytes_total ${observability.reclaimedBytes}`,
  '# TYPE bridge_state_store_capacity_rejections_total counter', `bridge_state_store_capacity_rejections_total ${observability.capacityRejections}`,
].join('\n') + '\n';

class StateStore {
  #db: DatabaseSync;
  #policy: ResolvedStatePolicy;
  #cleanupTimer?: ReturnType<typeof setInterval>;
  #observability: StateObservability = { bytes: 0, cleanupRuns: 0, deletedChains: 0, reclaimedBytes: 0, capacityRejections: 0 };

  constructor(path: string, policy: ResolvedStatePolicy) {
    this.#policy = policy;
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
          parallel_tool_calls INTEGER NOT NULL DEFAULT 0,
          native_upstream_base_url TEXT,
          native_upstream_identity TEXT,
          native_upstream_response_id TEXT,
          context_complete INTEGER NOT NULL DEFAULT 1,
          output_text TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL DEFAULT 0,
          terminal_at INTEGER
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
        CREATE TABLE IF NOT EXISTS idempotency_records (
          auth_subject TEXT NOT NULL,
          key TEXT NOT NULL,
          request_hash TEXT NOT NULL,
          response_id TEXT NOT NULL UNIQUE,
          PRIMARY KEY (auth_subject, key)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS attempts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          response_id TEXT NOT NULL,
          attempt_index INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL DEFAULT 0,
          finished_at INTEGER,
          result TEXT,
          pre_output_failure INTEGER,
          error_code TEXT
        ) STRICT;
      `);
      this.#addColumn('parent_id TEXT');
      this.#addColumn("model TEXT NOT NULL DEFAULT 'gpt-4.1'");
      this.#addColumn("input_json TEXT NOT NULL DEFAULT '[]'");
      this.#addColumn("tools_json TEXT NOT NULL DEFAULT '[]'");
      this.#addColumn('parallel_tool_calls INTEGER NOT NULL DEFAULT 0');
      this.#addColumn('native_upstream_base_url TEXT');
      this.#addColumn('native_upstream_identity TEXT');
      this.#addColumn('native_upstream_response_id TEXT');
      this.#addColumn('context_complete INTEGER NOT NULL DEFAULT 0');
      const responseCreatedAtAdded = this.#addColumn('created_at INTEGER NOT NULL DEFAULT 0');
      const terminalAtAdded = this.#addColumn('terminal_at INTEGER');
      const attemptCreatedAtAdded = this.#addAttemptColumn('created_at INTEGER NOT NULL DEFAULT 0');
      this.#addAttemptColumn('attempt_index INTEGER NOT NULL DEFAULT 0');
      this.#addAttemptColumn('finished_at INTEGER');
      this.#addAttemptColumn('result TEXT');
      this.#addAttemptColumn('pre_output_failure INTEGER');
      this.#addAttemptColumn('error_code TEXT');
      const now = Date.now();
      if (responseCreatedAtAdded) this.#db.prepare('UPDATE responses SET created_at = ? WHERE created_at = 0').run(now);
      if (terminalAtAdded) this.#db.prepare("UPDATE responses SET terminal_at = ? WHERE status IN ('completed', 'failed', 'cancelled', 'incomplete')").run(now);
      if (attemptCreatedAtAdded) this.#db.prepare('UPDATE attempts SET created_at = ? WHERE created_at = 0').run(now);
      this.cleanup();
      this.#cleanupTimer = setInterval(() => this.cleanup(), HOUR);
      this.#cleanupTimer.unref?.();
    } catch (error) {
      throw new Error(`State Store is not writable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  #addColumn(definition: string) {
    const name = definition.split(' ')[0];
    const columns = this.#db.prepare('PRAGMA table_info(responses)').all().map((row) => String(row.name));
    if (columns.includes(name)) return false;
    this.#db.exec(`ALTER TABLE responses ADD COLUMN ${definition}`);
    return true;
  }

  #addAttemptColumn(definition: string) {
    const name = definition.split(' ')[0];
    const columns = this.#db.prepare('PRAGMA table_info(attempts)').all().map((row) => String(row.name));
    if (columns.includes(name)) return false;
    this.#db.exec(`ALTER TABLE attempts ADD COLUMN ${definition}`);
    return true;
  }

  #createResponse(response: Omit<StoredResponse, 'output'>) {
    this.#db.prepare(
      'INSERT INTO responses (id, parent_id, status, model, input_json, tools_json, parallel_tool_calls, context_complete, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)',
    ).run(response.id, response.parentId ?? null, 'queued', response.model, JSON.stringify(response.input), JSON.stringify(response.tools), Number(response.parallelToolCalls), Date.now());
  }

  #bytes() {
    const pageCount = Number((this.#db.prepare('PRAGMA page_count').get() as Record<string, unknown>).page_count);
    const pageSize = Number((this.#db.prepare('PRAGMA page_size').get() as Record<string, unknown>).page_size);
    return pageCount * pageSize;
  }

  #chainRows(rootId: string) {
    return this.#db.prepare(`
      WITH RECURSIVE response_chain(id) AS (
        VALUES (?)
        UNION ALL
        SELECT responses.id FROM responses JOIN response_chain ON responses.parent_id = response_chain.id
      )
      SELECT id, status, terminal_at FROM responses WHERE id IN response_chain
    `).all(rootId).map((row) => ({
      id: String(row.id), status: String(row.status), terminalAt: row.terminal_at === null ? undefined : Number(row.terminal_at),
    }));
  }

  #deleteChain(ids: string[]) {
    const placeholders = ids.map(() => '?').join(', ');
    this.#db.prepare(`DELETE FROM output_items WHERE response_id IN (${placeholders})`).run(...ids);
    this.#db.prepare(`DELETE FROM stream_events WHERE response_id IN (${placeholders})`).run(...ids);
    this.#db.prepare(`DELETE FROM idempotency_records WHERE response_id IN (${placeholders})`).run(...ids);
    this.#db.prepare(`DELETE FROM attempts WHERE response_id IN (${placeholders})`).run(...ids);
    this.#db.prepare(`DELETE FROM responses WHERE id IN (${placeholders})`).run(...ids);
  }

  cleanup(limit = this.#policy.cleanupThresholdBytes) {
    const startedAt = Date.now();
    const beforeBytes = this.#bytes();
    let deletedChains = 0;
    try {
      const responseCutoff = startedAt - this.#policy.responseRetentionDays * DAY;
      const attemptCutoff = startedAt - this.#policy.attemptRetentionDays * DAY;
      let deletedAttempts = 0;
      this.#db.exec('BEGIN IMMEDIATE');
      try {
        deletedAttempts = Number(this.#db.prepare(`
          DELETE FROM attempts WHERE created_at < ? AND response_id IN (
            SELECT id FROM responses WHERE status IN ('completed', 'failed', 'cancelled', 'incomplete')
          )
        `).run(attemptCutoff).changes);
        this.#db.exec('COMMIT');
      } catch (error) {
        this.#db.exec('ROLLBACK');
        throw error;
      }
      if (deletedAttempts) this.#db.exec('VACUUM');
      const roots = this.#db.prepare('SELECT id FROM responses WHERE parent_id IS NULL ORDER BY terminal_at, id').all();
      for (const root of roots) {
        if (this.#bytes() < limit) break;
        const chain = this.#chainRows(String(root.id));
        const lastTerminalAt = Math.max(...chain.map(({ terminalAt }) => terminalAt ?? Number.POSITIVE_INFINITY));
        if (!chain.length || !chain.every(({ status }) => terminalStatuses.has(status)) || lastTerminalAt >= responseCutoff) continue;
        this.#db.exec('BEGIN IMMEDIATE');
        try {
          this.#deleteChain(chain.map(({ id }) => id));
          this.#db.exec('COMMIT');
        } catch (error) {
          this.#db.exec('ROLLBACK');
          throw error;
        }
        this.#db.exec('VACUUM');
        deletedChains += 1;
      }
      const reclaimedBytes = Math.max(0, beforeBytes - this.#bytes());
      this.#observability.cleanupRuns += 1;
      this.#observability.deletedChains += deletedChains;
      this.#observability.reclaimedBytes += reclaimedBytes;
      this.#observability.bytes = this.#bytes();
      this.#observability.lastCleanup = { startedAt, endedAt: Date.now(), deletedChains, reclaimedBytes };
      log('info', 'state_store_cleanup', { durationMs: Date.now() - startedAt, deleted_chains: deletedChains, reclaimed_bytes: reclaimedBytes });
    } catch {
      this.#observability.cleanupRuns += 1;
      this.#observability.bytes = this.#bytes();
      this.#observability.lastCleanup = { startedAt, endedAt: Date.now(), deletedChains, reclaimedBytes: 0, failureReason: 'cleanup_failed' };
      log('error', 'state_store_cleanup', { durationMs: Date.now() - startedAt, errorCode: 'cleanup_failed' });
    }
  }

  #hasCapacityFor(response: Omit<StoredResponse, 'output'>) {
    const reservedBytes = Buffer.byteLength(JSON.stringify(response.input)) + Buffer.byteLength(JSON.stringify(response.tools)) + 1024;
    if (this.#bytes() + reservedBytes >= this.#policy.cleanupThresholdBytes) {
      this.cleanup(Math.max(0, this.#policy.cleanupThresholdBytes - reservedBytes));
    }
    if (this.#bytes() + reservedBytes < this.#policy.hardLimitBytes) return true;
    this.#observability.capacityRejections += 1;
    this.#observability.bytes = this.#bytes();
    return false;
  }

  claimResponse(response: Omit<StoredResponse, 'output'>, idempotency?: { subject: string; key: string; hash: string }): IdempotencyClaim {
    if (idempotency) {
      const existing = this.#db.prepare(
        'SELECT request_hash, response_id FROM idempotency_records WHERE auth_subject = ? AND key = ?',
      ).get(idempotency.subject, idempotency.key) as Record<string, unknown> | undefined;
      if (existing) {
        return String(existing.request_hash) === idempotency.hash
          ? { kind: 'reused', responseId: String(existing.response_id) }
          : { kind: 'conflict' };
      }
    }
    if (!this.#hasCapacityFor(response)) return { kind: 'capacity_exceeded' };
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      if (idempotency) {
        const existing = this.#db.prepare(
          'SELECT request_hash, response_id FROM idempotency_records WHERE auth_subject = ? AND key = ?',
        ).get(idempotency.subject, idempotency.key) as Record<string, unknown> | undefined;
        if (existing) {
          this.#db.exec('COMMIT');
          return String(existing.request_hash) === idempotency.hash
            ? { kind: 'reused', responseId: String(existing.response_id) }
            : { kind: 'conflict' };
        }
      }
      this.#createResponse(response);
      if (idempotency) {
        this.#db.prepare(
          'INSERT INTO idempotency_records (auth_subject, key, request_hash, response_id) VALUES (?, ?, ?, ?)',
        ).run(idempotency.subject, idempotency.key, idempotency.hash, response.id);
      }
      this.#db.exec('COMMIT');
      return { kind: 'created', responseId: response.id };
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  appendOutputItem(responseId: string, outputIndex: number, item: OutputItem) {
    this.#db.prepare('INSERT INTO output_items (response_id, output_index, item_json) VALUES (?, ?, ?)')
      .run(responseId, outputIndex, JSON.stringify(item));
  }

  setNativeUpstream(responseId: string, mapping: NativeUpstreamMapping) {
    this.#db.prepare('UPDATE responses SET native_upstream_base_url = ?, native_upstream_identity = ?, native_upstream_response_id = ? WHERE id = ?')
      .run(mapping.baseUrl, mapping.identity, mapping.responseId, responseId);
  }

  startAttempt(responseId: string) {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#db.prepare("UPDATE responses SET status = 'in_progress' WHERE id = ? AND status = 'queued'").run(responseId);
      const index = Number((this.#db.prepare('SELECT COUNT(*) AS count FROM attempts WHERE response_id = ?').get(responseId) as Record<string, unknown>).count) + 1;
      const result = this.#db.prepare('INSERT INTO attempts (response_id, attempt_index, created_at) VALUES (?, ?, ?)').run(responseId, index, Date.now());
      this.#db.exec('COMMIT');
      return Number(result.lastInsertRowid);
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  finishAttempt(attempt: AttemptCompletion) {
    this.#db.prepare(
      'UPDATE attempts SET finished_at = ?, result = ?, pre_output_failure = ?, error_code = ? WHERE id = ?',
    ).run(Date.now(), attempt.result, Number(attempt.preOutputFailure), attempt.errorCode ?? null, attempt.id);
  }

  appendEvent(responseId: string, event: ResponseEvent): StoredEvent {
    const result = this.#db.prepare(
      'INSERT INTO stream_events (response_id, type, payload) VALUES (?, ?, ?)',
    ).run(responseId, event.type, JSON.stringify(event));
    return { sequence: Number(result.lastInsertRowid), type: event.type };
  }

  terminal(id: string, status: 'completed' | 'failed' | 'cancelled', outputText: string, event: ResponseEvent, attempt?: AttemptCompletion): StoredEvent {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      if (attempt) {
        this.#db.prepare(
          'UPDATE attempts SET finished_at = ?, result = ?, pre_output_failure = ?, error_code = ? WHERE id = ?',
        ).run(Date.now(), attempt.result, Number(attempt.preOutputFailure), attempt.errorCode ?? null, attempt.id);
      }
      this.#db.prepare('UPDATE responses SET status = ?, output_text = ?, terminal_at = COALESCE(terminal_at, ?) WHERE id = ?')
        .run(status, outputText, Date.now(), id);
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
        'SELECT id, parent_id, status, model, input_json, tools_json, parallel_tool_calls, native_upstream_base_url, native_upstream_identity, native_upstream_response_id, context_complete FROM responses WHERE id = ?',
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
        tools: JSON.parse(String(row.tools_json)) as Tool[],
        parallelToolCalls: Boolean(row.parallel_tool_calls),
        nativeUpstream: row.native_upstream_base_url === null || row.native_upstream_identity === null || row.native_upstream_response_id === null ? undefined : {
          baseUrl: String(row.native_upstream_base_url), identity: String(row.native_upstream_identity), responseId: String(row.native_upstream_response_id),
        },
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

  eventsForResponse(id: string, after: number) {
    return this.#db.prepare(
      'SELECT sequence, payload FROM stream_events WHERE response_id = ? AND sequence > ? ORDER BY sequence',
    ).all(id, after).map((row) => ({ sequence: Number(row.sequence), event: JSON.parse(String(row.payload)) as ResponseEvent }));
  }

  status(id: string) {
    const row = this.#db.prepare('SELECT status FROM responses WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? String(row.status) : undefined;
  }

  attempts() {
    return this.#db.prepare('SELECT response_id FROM attempts ORDER BY id')
      .all().map((row) => ({ responseId: String(row.response_id) }));
  }

  attemptDetails() {
    return this.#db.prepare('SELECT response_id, attempt_index, created_at, finished_at, result, pre_output_failure, error_code FROM attempts ORDER BY id')
      .all().map((row) => ({
        responseId: String(row.response_id), attemptIndex: Number(row.attempt_index), createdAt: Number(row.created_at),
        finishedAt: row.finished_at === null ? undefined : Number(row.finished_at), result: row.result === null ? undefined : String(row.result),
        preOutputFailure: row.pre_output_failure === null ? undefined : Boolean(row.pre_output_failure), errorCode: row.error_code === null ? undefined : String(row.error_code),
      }));
  }

  observability(): StateObservability {
    return { ...this.#observability, bytes: this.#bytes(), lastCleanup: this.#observability.lastCleanup && { ...this.#observability.lastCleanup } };
  }

  isReady() {
    try {
      this.#db.prepare('SELECT 1').get();
      return true;
    } catch {
      return false;
    }
  }

  discardRejectedResponse(id: string) {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#db.prepare('DELETE FROM attempts WHERE response_id = ?').run(id);
      this.#db.prepare('DELETE FROM idempotency_records WHERE response_id = ?').run(id);
      this.#db.prepare('DELETE FROM responses WHERE id = ?').run(id);
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  responses() {
    return this.#db.prepare('SELECT status, output_text FROM responses ORDER BY rowid')
      .all().map((row) => ({ status: String(row.status), outputText: String(row.output_text) }));
  }

  close() {
    if (this.#cleanupTimer) clearInterval(this.#cleanupTimer);
    this.#db.close();
  }
}

export type RunningBridge = {
  url: string;
  state: Pick<StateStore, 'events' | 'responses' | 'attempts' | 'attemptDetails' | 'observability'>;
  close: () => Promise<void>;
};

const upstreamReady = async (upstream: Upstream) => {
  try {
    const response = await fetch(new URL('/v1/models', upstream.baseUrl), {
      headers: { authorization: `Bearer ${upstream.apiKey}` },
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok;
  } catch {
    return false;
  }
};

const sendError = (response: ServerResponse, status: number, message: string, code: string) => {
  errorCodes.set(response, code);
  response.writeHead(status, { 'content-type': 'application/json', 'x-request-id': requestIds.get(response) ?? randomUUID() });
  response.end(JSON.stringify({ error: { message, type: 'invalid_request_error', param: null, code } }));
};

const requireBridgeAuthentication = (request: IncomingMessage, response: ServerResponse, apiKey: string) => {
  if (request.headers.authorization === `Bearer ${apiKey}`) return true;
  sendError(response, 401, 'Invalid authentication credentials', 'invalid_api_key');
  return false;
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
    if (value.type === 'message' && (value.role === 'user' || value.role === 'developer') && Array.isArray(value.content)) {
      const text = value.content.map((part) => {
        if (!part || typeof part !== 'object') return undefined;
        const content = part as Record<string, unknown>;
        return content.type === 'input_text' && typeof content.text === 'string' ? content.text : undefined;
      });
      if (!text.length || text.some((part) => part === undefined)) return undefined;
      items.push({ type: 'message', role: value.role, content: text.join('') });
      continue;
    }
    if ((value.type !== 'function_call_output' && value.type !== 'custom_tool_call_output') || typeof value.call_id !== 'string' || typeof value.output !== 'string') return undefined;
    items.push({ type: value.type, call_id: value.call_id, output: value.output });
  }
  return items;
};

const normalizeTools = (tools: unknown): Tool[] | undefined => {
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
    if ((value.type !== 'function' && value.type !== 'custom') || typeof value.name !== 'string' || value.name.length === 0) return undefined;
    if (value.description !== undefined && typeof value.description !== 'string') return undefined;
    if (value.type === 'function') {
      normalized.push({
        type: 'function', name: value.name,
        ...(typeof value.description === 'string' ? { description: value.description } : {}),
        ...(value.parameters !== undefined ? { parameters: value.parameters } : {}),
      });
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

const toChatTools = (tools: Tool[]) => tools.filter((tool): tool is FunctionTool | CustomTool => tool.type !== 'web_search').map((tool) => tool.type === 'function' ? {
  type: 'function' as const,
  function: {
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    ...(tool.parameters === undefined ? {} : { parameters: tool.parameters }),
  },
} : {
  type: 'custom' as const,
  custom: {
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    ...(tool.format === undefined ? {} : { format: tool.format }),
  },
});

const WEB_SEARCH_UNAVAILABLE_HINT = 'Hosted web search is unavailable on this upstream. Do not claim you performed a live web search, cite live results, or invent search calls.';

const toChatMessages = (response: StoredResponse): ChatMessage[] => {
  const messages: ChatMessage[] = response.input.map((item) => item.type === 'message'
    ? { role: item.role === 'developer' ? 'system' : 'user', content: item.content }
    : { role: 'tool', tool_call_id: item.call_id, content: item.output });
  const toolCalls = response.output.filter((item): item is Extract<OutputItem, { type: 'function_call' | 'custom_tool_call' }> => item.type === 'function_call' || item.type === 'custom_tool_call');
  const text = response.output.find((item): item is Extract<OutputItem, { type: 'message' }> => item.type === 'message');
  if (text || toolCalls.length) {
    messages.push({
      role: 'assistant',
      ...(text ? { content: text.content.map((part) => part.text).join('') } : {}),
      ...(toolCalls.length ? { tool_calls: toolCalls.map((item): ChatToolCall => item.type === 'function_call'
        ? { id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } }
        : { id: item.call_id, type: 'custom', custom: { name: item.name, input: item.input } }) } : {}),
    });
  }
  return messages;
};

const sse = (response: ServerResponse, store: StateStore, responseId: string, event: ResponseEvent) => {
  store.appendEvent(responseId, event);
  response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
};

const terminalSse = (response: ServerResponse, store: StateStore, responseId: string, status: 'completed' | 'failed', outputText: string, event: ResponseEvent, attempt?: AttemptCompletion) => {
  store.terminal(responseId, status, outputText, event, attempt);
  response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
};

const finishUpstreamFailure = (response: ServerResponse, store: StateStore, id: string, status: number, message: string, code: string) => {
  store.discardRejectedResponse(id);
  sendError(response, status, message, code);
};

const writeSse = (response: ServerResponse, event: ResponseEvent) => {
  response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
};

const replaySse = async (response: ServerResponse, store: StateStore, responseId: string) => {
  let sequence = 0;
  while (!response.destroyed) {
    const events = store.eventsForResponse(responseId, sequence);
    for (const event of events) {
      sequence = event.sequence;
      writeSse(response, event.event);
    }
    if (!events.length && store.status(responseId) !== 'in_progress') break;
    if (!events.length) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  response.end();
};

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
};

const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');

const upstreamIdentity = (upstream: Upstream) => digest({ baseUrl: upstream.baseUrl, apiKey: upstream.apiKey, wireApi: upstream.wireApi ?? 'chat' });

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

const replaceResponseId = (event: ResponseEvent, upstreamId: string, bridgeId: string): ResponseEvent => {
  const response = event.response;
  const mapped = {
    ...event,
    ...(event.response_id === upstreamId ? { response_id: bridgeId } : {}),
  };
  if (!response || typeof response !== 'object' || (response as Record<string, unknown>).id !== upstreamId) return mapped;
  return { ...mapped, response: { ...(response as Record<string, unknown>), id: bridgeId } };
};

const responseIdFromEvent = (event: ResponseEvent) => {
  const response = event.response;
  return response && typeof response === 'object' && typeof (response as Record<string, unknown>).id === 'string'
    ? String((response as Record<string, unknown>).id) : undefined;
};

const streamNativeResponses = async ({
  response, state, id, model, upstreams, upstreamBody, options, metrics,
}: {
  response: ServerResponse; state: StateStore; id: string; model: string; upstreams: Upstream[];
  upstreamBody: Record<string, unknown>; options: BridgeOptions; metrics: Metrics;
}) => {
  let streamStarted = false;
  let failedOutputText = '';
  let terminalAttempt: AttemptCompletion | undefined;
  let retryAttempt: AttemptCompletion | undefined;
  for (let index = 0; index < upstreams.length; index += 1) {
    const upstream = upstreams[index];
    if (retryAttempt) {
      state.finishAttempt(retryAttempt);
      retryAttempt = undefined;
    }
    const abort = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const armTimeout = (milliseconds: number) => {
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => abort.abort(), milliseconds);
    };
    armTimeout(options.firstEventTimeoutMs ?? 30_000);
    const finishAttempt = () => { if (timeout) clearTimeout(timeout); timeout = undefined; };
    const attemptId = state.startAttempt(id);
    if (index > 0) metrics.upstreamSwitches += 1;
    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetch(new URL('/v1/responses', upstream.baseUrl), {
        method: 'POST', headers: { authorization: `Bearer ${upstream.apiKey}`, 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify(upstreamBody), signal: abort.signal,
      });
    } catch {
      finishAttempt();
      retryAttempt = { id: attemptId, result: 'failed', preOutputFailure: true, errorCode: 'upstream_retryable' };
      continue;
    }
    if (upstreamResponse.status === 408 || upstreamResponse.status === 429 || upstreamResponse.status >= 500 || !upstreamResponse.body) {
      finishAttempt();
      retryAttempt = { id: attemptId, result: 'failed', preOutputFailure: true, errorCode: 'upstream_retryable' };
      continue;
    }
    if (upstreamResponse.status >= 400) {
      finishAttempt();
      finishUpstreamFailure(response, state, id, 400, 'Upstream rejected request', 'upstream_rejected');
      return;
    }
    let outputStarted = false;
    let firstEvent = true;
    let upstreamResponseId: string | undefined;
    const pending: ResponseEvent[] = [];
    const start = () => {
      if (streamStarted) return;
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      streamStarted = true;
      for (const event of pending) sse(response, state, id, event);
      pending.length = 0;
    };
    try {
      for await (const data of parseUpstream(upstreamResponse.body)) {
        if (firstEvent) {
          firstEvent = false;
          finishAttempt();
        }
        const raw = JSON.parse(data) as ResponseEvent;
        if (typeof raw.type !== 'string') throw new Error('Invalid upstream Responses event');
        upstreamResponseId ??= responseIdFromEvent(raw);
        if (upstreamResponseId) state.setNativeUpstream(id, { baseUrl: upstream.baseUrl, identity: upstreamIdentity(upstream), responseId: upstreamResponseId });
        const event = upstreamResponseId ? replaceResponseId(raw, upstreamResponseId, id) : raw;
        const terminal = event.type === 'response.completed' || event.type === 'response.failed' || event.type === 'response.cancelled';
        const preamble = event.type === 'response.created' || event.type === 'response.in_progress';
        if (!preamble && !upstreamResponseId) throw new Error('Upstream Response ID is missing');
        if (terminal && event.type !== 'response.completed' && !outputStarted) throw new Error('Upstream Responses failed before output');
        if (preamble) {
          pending.push(event);
          armTimeout(options.outputIdleTimeoutMs ?? 60_000);
          continue;
        }
        outputStarted = true;
        if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') failedOutputText += event.delta;
        armTimeout(options.outputIdleTimeoutMs ?? 60_000);
        start();
        if (event.type === 'response.output_item.done'
          && Number.isInteger(event.output_index) && Number(event.output_index) >= 0
          && event.item && typeof event.item === 'object'
          && ['message', 'function_call', 'custom_tool_call', 'web_search_call'].includes(String((event.item as Record<string, unknown>).type))) {
          state.appendOutputItem(id, Number(event.output_index), event.item as OutputItem);
        }
        if (event.type === 'response.completed') {
          finishAttempt();
          terminalSse(response, state, id, 'completed', failedOutputText, event, { id: attemptId, result: 'completed', preOutputFailure: false });
          response.end();
          return;
        }
        if (event.type === 'response.failed' || event.type === 'response.cancelled') {
          finishAttempt();
          terminalSse(response, state, id, 'failed', failedOutputText, event, { id: attemptId, result: 'failed', preOutputFailure: false, errorCode: 'upstream_stream_failed' });
          response.end();
          return;
        }
        sse(response, state, id, event);
      }
      throw new Error('Upstream Responses stream ended without completion');
    } catch {
      finishAttempt();
      if (outputStarted) {
        terminalAttempt = { id: attemptId, result: 'failed', preOutputFailure: false, errorCode: 'upstream_stream_failed' };
        break;
      }
      retryAttempt = { id: attemptId, result: 'failed', preOutputFailure: true, errorCode: 'upstream_retryable' };
    }
  }
  if (!streamStarted) {
    finishUpstreamFailure(response, state, id, 503, 'Upstream unavailable', 'upstream_unavailable');
    return;
  }
  errorCodes.set(response, 'upstream_stream_failed');
  terminalSse(response, state, id, 'failed', failedOutputText, { type: 'response.failed', response: { id, object: 'response', status: 'failed' } }, terminalAttempt ?? retryAttempt);
  response.end();
};

const assertOptions = (options: BridgeOptions) => {
  if (!options.apiKey.trim()) throw new Error('Bridge API key is required');
  if (!options.upstreams.length) throw new Error('Upstream Pool is required');
  for (const upstream of options.upstreams) {
    try { new URL(upstream.baseUrl); } catch { throw new Error('Upstream Pool contains an invalid URL'); }
    if (!upstream.apiKey.trim()) throw new Error('Upstream Pool contains an empty API key');
    if (upstream.wireApi !== undefined && upstream.wireApi !== 'chat' && upstream.wireApi !== 'responses') {
      throw new Error('Upstream Pool contains an invalid wire API');
    }
    if (upstream.capabilities && Object.values(upstream.capabilities).some((value) => typeof value !== 'boolean')) {
      throw new Error('Upstream Pool contains an invalid capability profile');
    }
  }
  if (options.firstEventTimeoutMs !== undefined && (!Number.isInteger(options.firstEventTimeoutMs) || options.firstEventTimeoutMs <= 0)) {
    throw new Error('First event timeout must be a positive integer');
  }
  if (options.outputIdleTimeoutMs !== undefined && (!Number.isInteger(options.outputIdleTimeoutMs) || options.outputIdleTimeoutMs <= 0)) {
    throw new Error('Output idle timeout must be a positive integer');
  }
  for (const value of Object.values(options.statePolicy ?? {})) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('State Store policy values must be positive integers');
  }
  const policy = { ...defaultStatePolicy, ...options.statePolicy };
  if (policy.cleanupThresholdBytes >= policy.hardLimitBytes) throw new Error('State Store cleanup threshold must be below the hard limit');
};

export const startBridge = async (options: BridgeOptions): Promise<RunningBridge> => {
  assertOptions(options);
  const state = new StateStore(options.statePath, { ...defaultStatePolicy, ...options.statePolicy });
  const metrics: Metrics = { requests: 0, failures: 0, durationMs: 0, upstreamSwitches: 0 };
  let server: Server | undefined;
  try {
    server = createServer(async (request, response) => {
      const requestId = randomUUID();
      const startedAt = Date.now();
      let responseId: string | undefined;
      requestIds.set(response, requestId);
      response.setHeader('x-request-id', requestId);
      const measuresRequest = request.method === 'POST' && request.url === '/v1/responses';
      let observed = false;
      const observeRequest = (disconnected = false) => {
        if (observed) return;
        observed = true;
        if (disconnected && !errorCodes.has(response)) errorCodes.set(response, 'client_disconnected');
        const durationMs = Date.now() - startedAt;
        if (measuresRequest) {
          metrics.requests += 1;
          metrics.durationMs += durationMs;
        }
        const errorCode = errorCodes.get(response) ?? null;
        if (measuresRequest && (response.statusCode >= 400 || errorCode)) metrics.failures += 1;
        log(response.statusCode >= 400 || errorCode ? 'error' : 'info', 'http_request_completed', {
          requestId, responseId: responseId ?? null, durationMs, errorCode, method: request.method ?? null, status: response.statusCode,
        });
      };
      response.once('finish', observeRequest);
      response.once('close', () => queueMicrotask(() => observeRequest(!response.writableEnded)));
      request.once('aborted', () => queueMicrotask(() => observeRequest(true)));
      if (request.method === 'GET' && request.url === '/healthz') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      if (request.method === 'GET' && request.url === '/readyz') {
        if (!requireBridgeAuthentication(request, response, options.apiKey)) return;
        const upstreamAvailable = await Promise.any(options.upstreams.map(async (upstream) => {
          if (await upstreamReady(upstream)) return true;
          throw new Error('upstream unavailable');
        })).catch(() => false);
        const ready = state.isReady() && upstreamAvailable;
        response.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ status: ready ? 'ready' : 'not_ready' }));
        return;
      }
      if (request.method === 'GET' && request.url === '/metrics') {
        if (!requireBridgeAuthentication(request, response, options.apiKey)) return;
        response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
        response.end(prometheus(metrics, state.observability()));
        return;
      }
      if (request.method !== 'POST' || request.url !== '/v1/responses') {
        sendError(response, 404, 'Not found', 'not_found');
        return;
      }
      if (!requireBridgeAuthentication(request, response, options.apiKey)) return;
      const idempotencyKey = request.headers['idempotency-key'];
      if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || !idempotencyKey)) {
        sendError(response, 400, 'Idempotency-Key must be a non-empty string', 'invalid_idempotency_key');
        return;
      }

      let payload: {
        stream?: unknown; input?: unknown; model?: unknown; tools?: unknown; previous_response_id?: unknown; parallel_tool_calls?: unknown;
        tool_choice?: unknown; include?: unknown;
      };
      try { payload = await readJson(request) as typeof payload; }
      catch { sendError(response, 400, 'Invalid JSON body', 'invalid_json'); return; }
      if (payload.stream !== true) {
        sendError(response, 400, 'Only stream: true is supported', 'stream_required');
        return;
      }
      const input = normalizeInput(payload.input);
      if (!input) {
        sendError(response, 400, 'Only text and Tool output input are supported', 'unsupported_input');
        return;
      }
      const tools = normalizeTools(payload.tools);
      if (payload.tools !== undefined && !tools) {
        sendError(response, 400, 'Only Function and Custom Tools are supported', 'unsupported_tools');
        return;
      }
      if (payload.previous_response_id !== undefined && (typeof payload.previous_response_id !== 'string' || !payload.previous_response_id)) {
        sendError(response, 400, 'previous_response_id must be a string', 'invalid_previous_response_id');
        return;
      }
      if (input.some((item) => item.type === 'function_call_output') && !payload.previous_response_id) {
        sendError(response, 400, 'Tool output requires previous_response_id', 'missing_previous_response_id');
        return;
      }

      let ancestors: StoredResponse[] = [];
      if (payload.previous_response_id) {
        try { ancestors = state.chain(payload.previous_response_id); }
        catch { sendError(response, 400, 'Previous response was not found', 'previous_response_not_found'); return; }
      }
      const callKinds = new Map((ancestors.at(-1)?.output ?? [])
        .filter((item): item is Extract<OutputItem, { type: 'function_call' | 'custom_tool_call' }> => item.type === 'function_call' || item.type === 'custom_tool_call')
        .map((item) => [item.call_id, item.type]));
      const nativeParent = ancestors.at(-1)?.nativeUpstream;
      if (!nativeParent && input.some((item) => {
        const kind = callKinds.get(item.type === 'message' ? '' : item.call_id);
        return item.type !== 'message' && kind !== (item.type === 'function_call_output' ? 'function_call' : 'custom_tool_call');
      })) {
        sendError(response, 400, 'Tool call was not found', 'function_call_not_found');
        return;
      }
      const effectiveTools = tools ?? [...ancestors].reverse().find((item) => item.tools.length > 0)?.tools ?? [];
      const chainTools = [...ancestors.flatMap((item) => item.tools), ...effectiveTools];
      const needs = {
        functionTools: chainTools.some((tool) => tool.type === 'function'),
        customTools: chainTools.some((tool) => tool.type === 'custom'),
        webSearch: chainTools.some((tool) => tool.type === 'web_search'),
        parallelToolCalls: payload.parallel_tool_calls === true || ancestors.some((item) => item.parallelToolCalls),
      };
      const matchesCapabilities = (upstream: Upstream, requireWebSearch: boolean) => (
        (!needs.functionTools || upstream.capabilities?.functionTools === true)
        && (!needs.customTools || upstream.capabilities?.customTools === true)
        && (!requireWebSearch || (upstream.wireApi === 'responses' && upstream.capabilities?.webSearch === true))
        && (!needs.parallelToolCalls || upstream.capabilities?.parallelToolCalls === true)
        && (!nativeParent || (upstream.wireApi === 'responses' && upstream.baseUrl === nativeParent.baseUrl && upstreamIdentity(upstream) === nativeParent.identity))
      );
      const nativeUpstreams = (needs.webSearch || nativeParent !== undefined)
        ? options.upstreams.filter((upstream) => matchesCapabilities(upstream, needs.webSearch))
        : [];
      const degradeWebSearch = needs.webSearch && nativeParent === undefined && nativeUpstreams.length === 0;
      const upstreams = degradeWebSearch
        ? options.upstreams.filter((upstream) => (upstream.wireApi ?? 'chat') === 'chat' && matchesCapabilities(upstream, false))
        : nativeUpstreams.length
          ? nativeUpstreams
          : options.upstreams.filter((upstream) => matchesCapabilities(upstream, false));
      if (!upstreams.length) {
        sendError(response, 400, 'No upstream supports the requested capabilities', 'unsupported_capabilities');
        return;
      }
      const nativeResponses = !degradeWebSearch && (needs.webSearch || nativeParent !== undefined);
      const chatTools = toChatTools(effectiveTools);
      const forcedWebSearchChoice = payload.tool_choice !== undefined && typeof payload.tool_choice === 'object' && payload.tool_choice !== null
        && (payload.tool_choice as { type?: unknown }).type === 'web_search';
      const messages: ChatMessage[] = [
        ...(degradeWebSearch ? [{ role: 'system' as const, content: WEB_SEARCH_UNAVAILABLE_HINT }] : []),
        ...ancestors.flatMap(toChatMessages),
        ...toChatMessages({ id: '', model: '', input, tools: [], parallelToolCalls: false, output: [] }),
      ];
      const model = typeof payload.model === 'string' ? payload.model : 'gpt-4.1';
      const upstreamBody: Record<string, unknown> = {
        model, stream: true, stream_options: { include_usage: true }, messages,
        ...(chatTools.length ? { tools: chatTools } : {}),
        ...(needs.parallelToolCalls ? { parallel_tool_calls: true } : {}),
        ...(degradeWebSearch && forcedWebSearchChoice ? { tool_choice: 'auto' } : {}),
      };

      const id = `resp_${randomUUID().replaceAll('-', '')}`;
      const claim = state.claimResponse({
        id, parentId: payload.previous_response_id, model, input, tools: tools ?? [], parallelToolCalls: payload.parallel_tool_calls === true,
      }, idempotencyKey === undefined ? undefined : {
        subject: digest(request.headers.authorization),
        key: idempotencyKey,
        hash: digest({
          model, input, tools: payload.tools ?? [], previousResponseId: payload.previous_response_id ?? null,
          parallelToolCalls: payload.parallel_tool_calls === true, toolChoice: payload.tool_choice, include: payload.include,
        }),
      });
      if (claim.kind === 'conflict') {
        sendError(response, 409, 'Idempotency-Key is already used for a different request', 'idempotency_key_conflict');
        return;
      }
      if (claim.kind === 'capacity_exceeded') {
        sendError(response, 503, 'State Store capacity is exhausted', 'state_store_capacity_exceeded');
        return;
      }
      if (claim.kind === 'reused') {
        responseId = claim.responseId;
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        await replaySse(response, state, claim.responseId);
        return;
      }
      responseId = id;

      if (nativeResponses) {
        const nativeUpstreamBody: Record<string, unknown> = {
          model, stream: true, input: payload.input,
          ...(payload.tools === undefined ? {} : { tools: payload.tools }),
          ...(payload.tool_choice === undefined ? {} : { tool_choice: payload.tool_choice }),
          ...(payload.include === undefined ? {} : { include: payload.include }),
          ...(nativeParent ? { previous_response_id: nativeParent.responseId } : {}),
          ...(payload.parallel_tool_calls === undefined ? {} : { parallel_tool_calls: payload.parallel_tool_calls }),
        };
        await streamNativeResponses({ response, state, id, model, upstreams, upstreamBody: nativeUpstreamBody, options, metrics });
        return;
      }

      let streamStarted = false;
      let cancelled = false;
      let activeAbort: AbortController | undefined;
      let failedOutputText = '';
      const cancel = () => { errorCodes.set(response, 'client_disconnected'); cancelled = true; activeAbort?.abort(); };
      const onResponseClose = () => { if (!response.writableEnded) cancel(); };
      request.once('aborted', cancel);
      response.once('close', onResponseClose);
      try {
        let upstreamAttempts = 0;
        let terminalAttempt: AttemptCompletion | undefined;
        let retryAttempt: AttemptCompletion | undefined;
        for (const upstream of upstreams) {
          if (cancelled) break;
          if (retryAttempt) {
            state.finishAttempt(retryAttempt);
            retryAttempt = undefined;
          }
          const abort = new AbortController();
          activeAbort = abort;
          let timeout: ReturnType<typeof setTimeout> | undefined;
          const armTimeout = (milliseconds: number) => {
            if (timeout) clearTimeout(timeout);
            timeout = setTimeout(() => abort.abort(), milliseconds);
          };
          const finishAttempt = () => {
            if (timeout) clearTimeout(timeout);
            activeAbort = undefined;
          };
          armTimeout(options.firstEventTimeoutMs ?? 30_000);
          const attemptId = state.startAttempt(id);
          if (upstreamAttempts > 0) metrics.upstreamSwitches += 1;
          upstreamAttempts += 1;
          let upstreamResponse: Response;
          try {
            upstreamResponse = await fetch(new URL('/v1/chat/completions', upstream.baseUrl), {
              method: 'POST',
              headers: { authorization: `Bearer ${upstream.apiKey}`, 'content-type': 'application/json', accept: 'text/event-stream' },
              body: JSON.stringify(upstreamBody), signal: abort.signal,
            });
          } catch {
            finishAttempt();
            if (cancelled) {
              terminalAttempt = { id: attemptId, result: 'cancelled', preOutputFailure: true, errorCode: 'client_disconnected' };
              break;
            }
            retryAttempt = { id: attemptId, result: 'failed', preOutputFailure: true, errorCode: 'upstream_retryable' };
            continue;
          }
          if (upstreamResponse.status === 408 || upstreamResponse.status === 429 || upstreamResponse.status >= 500 || !upstreamResponse.body) {
            finishAttempt();
            retryAttempt = { id: attemptId, result: 'failed', preOutputFailure: true, errorCode: 'upstream_retryable' };
            continue;
          }
          if (upstreamResponse.status >= 400) {
            finishAttempt();
            if (!streamStarted) {
              finishUpstreamFailure(response, state, id, 400, 'Upstream rejected request', 'upstream_rejected');
              return;
            }
            terminalAttempt = { id: attemptId, result: 'failed', preOutputFailure: true, errorCode: 'upstream_rejected' };
            break;
          }
          if (!streamStarted) {
            response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
            sse(response, state, id, { type: 'response.created', response: { id, object: 'response', status: 'in_progress', model, output: [] } });
            streamStarted = true;
          }

          let outputStarted = false;
          let firstEvent = true;
          let outputText = '';
          let completed = false;
          let nextOutputIndex = 0;
          let textOutputIndex: number | undefined;
          const calls = new Map<number, { id?: string; name?: string; kind: 'function' | 'custom'; input: string; outputIndex: number }>();
          try {
            for await (const data of parseUpstream(upstreamResponse.body)) {
              if (firstEvent) {
                firstEvent = false;
                if (timeout) clearTimeout(timeout);
                timeout = undefined;
              }
              if (outputStarted) armTimeout(options.outputIdleTimeoutMs ?? 60_000);
              if (data === '[DONE]') { completed = true; break; }
              const chunk = JSON.parse(data) as { choices?: Array<{ delta?: { content?: unknown; tool_calls?: Array<{ index?: unknown; id?: unknown; type?: unknown; function?: { name?: unknown; arguments?: unknown }; custom?: { name?: unknown; input?: unknown } }> } }> };
              const delta = chunk.choices?.[0]?.delta;
              if (typeof delta?.content === 'string' && delta.content.length) {
                if (textOutputIndex === undefined) textOutputIndex = nextOutputIndex++;
                outputStarted = true;
                armTimeout(options.outputIdleTimeoutMs ?? 60_000);
                outputText += delta.content;
                sse(response, state, id, { type: 'response.output_text.delta', item_id: `msg_${id}`, output_index: textOutputIndex, content_index: 0, delta: delta.content });
              }
              for (const call of delta?.tool_calls ?? []) {
                if (!Number.isInteger(call.index) || Number(call.index) < 0) throw new Error('Invalid upstream Tool call');
                if (call.type !== undefined && call.type !== 'function' && call.type !== 'custom') throw new Error('Invalid upstream Tool call');
                const kind = call.type === 'custom' ? 'custom' : 'function';
                const current = calls.get(Number(call.index)) ?? {
                  kind, input: '', outputIndex: Number(call.index) + (textOutputIndex === undefined ? 0 : 1),
                };
                if (current.kind !== kind) throw new Error('Inconsistent upstream Tool call');
                nextOutputIndex = Math.max(nextOutputIndex, current.outputIndex + 1);
                if (typeof call.id === 'string') current.id = call.id;
                const name = current.kind === 'function' ? call.function?.name : call.custom?.name;
                const inputDelta = current.kind === 'function' ? call.function?.arguments : call.custom?.input;
                if (typeof name === 'string') current.name = name;
                if (typeof inputDelta === 'string') {
                  outputStarted = true;
                  armTimeout(options.outputIdleTimeoutMs ?? 60_000);
                  current.input += inputDelta;
                  sse(response, state, id, {
                    type: current.kind === 'function' ? 'response.function_call_arguments.delta' : 'response.custom_tool_call_input.delta',
                    item_id: current.id ?? `tc_${Number(call.index)}`, output_index: current.outputIndex, delta: inputDelta,
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
              if (!call.id || !call.name) throw new Error('Incomplete upstream Tool call');
              orderedOutput.push({
                index: call.outputIndex,
                item: call.kind === 'function'
                  ? { id: call.id, type: 'function_call', status: 'completed', call_id: call.id, name: call.name, arguments: call.input }
                  : { id: call.id, type: 'custom_tool_call', status: 'completed', call_id: call.id, name: call.name, input: call.input },
              });
              sse(response, state, id, call.kind === 'function'
                ? { type: 'response.function_call_arguments.done', item_id: call.id, output_index: call.outputIndex, arguments: call.input }
                : { type: 'response.custom_tool_call_input.done', item_id: call.id, output_index: call.outputIndex, input: call.input });
            }
            const output = orderedOutput.sort((left, right) => left.index - right.index).map(({ item }) => item);
            for (const [index, item] of output.entries()) {
              state.appendOutputItem(id, index, item);
              sse(response, state, id, { type: 'response.output_item.done', output_index: index, item });
            }
            finishAttempt();
            terminalSse(response, state, id, 'completed', outputText, { type: 'response.completed', response: { id, object: 'response', status: 'completed', model, output } }, { id: attemptId, result: 'completed', preOutputFailure: false });
            response.end();
            return;
          } catch {
            finishAttempt();
            if (cancelled) {
              failedOutputText = outputText;
              terminalAttempt = { id: attemptId, result: 'cancelled', preOutputFailure: !outputStarted, errorCode: 'client_disconnected' };
              break;
            }
            if (outputStarted) {
              failedOutputText = outputText;
              terminalAttempt = { id: attemptId, result: 'failed', preOutputFailure: false, errorCode: 'upstream_stream_failed' };
              break;
            }
            retryAttempt = { id: attemptId, result: 'failed', preOutputFailure: true, errorCode: 'upstream_retryable' };
          }
        }
        if (cancelled) {
          const cancelledAttempt = terminalAttempt ?? (retryAttempt && { ...retryAttempt, result: 'cancelled' as const, errorCode: 'client_disconnected' });
          state.terminal(id, 'cancelled', failedOutputText, { type: 'response.cancelled', response: { id, object: 'response', status: 'cancelled' } }, cancelledAttempt);
          if (!response.destroyed) response.end();
          return;
        }
        if (!streamStarted) {
          finishUpstreamFailure(response, state, id, 503, 'Upstream unavailable', 'upstream_unavailable');
          return;
        }
        errorCodes.set(response, 'upstream_stream_failed');
        terminalSse(response, state, id, 'failed', failedOutputText, { type: 'response.failed', response: { id, object: 'response', status: 'failed' } }, terminalAttempt ?? retryAttempt);
        response.end();
      } finally {
        request.removeListener('aborted', cancel);
        response.removeListener('close', onResponseClose);
      }
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

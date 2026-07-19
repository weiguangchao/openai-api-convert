import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type {
  AttemptCompletion,
  BridgeLog,
  IdempotencyClaim,
  InputItem,
  OutputItem,
  ResolvedStatePolicy,
  ResponseEvent,
  ResponsesUsage,
  StoredEvent,
  StoredResponse,
  Tool,
} from './types.js';

export const GIB = 1024 ** 3;
export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;
export const zeroResponsesUsage: ResponsesUsage = {
  input_tokens: 0, output_tokens: 0, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 },
};
export const terminalStatuses = new Set(['completed', 'failed', 'cancelled', 'incomplete']);
export const defaultStatePolicy: ResolvedStatePolicy = {
  responseRetentionDays: 30,
  attemptRetentionDays: 7,
  cleanupThresholdBytes: 8 * GIB,
  hardLimitBytes: 10 * GIB,
};

export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
};

export const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');

export class StateStore {
  #db: DatabaseSync;
  #policy: ResolvedStatePolicy;
  #log: BridgeLog;
  #cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(path: string, policy: ResolvedStatePolicy, log: BridgeLog) {
    this.#policy = policy;
    this.#log = log;
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
          context_complete INTEGER NOT NULL DEFAULT 1,
          output_text TEXT NOT NULL DEFAULT '',
          usage_json TEXT NOT NULL DEFAULT '',
          incomplete_reason TEXT,
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
      this.#addColumn('context_complete INTEGER NOT NULL DEFAULT 0');
      this.#addColumn("usage_json TEXT NOT NULL DEFAULT ''");
      this.#addColumn('incomplete_reason TEXT');
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
      this.#db.prepare("UPDATE responses SET usage_json = ? WHERE usage_json = ''").run(JSON.stringify(zeroResponsesUsage));
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
      const endedAt = Date.now();
      this.#log('info', 'state_store_cleanup', {
        durationMs: endedAt - startedAt, started_at: startedAt, ended_at: endedAt, deleted_chains: deletedChains, reclaimed_bytes: reclaimedBytes,
      });
    } catch {
      const endedAt = Date.now();
      this.#log('error', 'state_store_cleanup', {
        durationMs: endedAt - startedAt, errorCode: 'cleanup_failed', started_at: startedAt, ended_at: endedAt, deleted_chains: deletedChains, reclaimed_bytes: 0,
      });
    }
  }

  #hasCapacityFor(response: Omit<StoredResponse, 'output'>) {
    const reservedBytes = Buffer.byteLength(JSON.stringify(response.input)) + Buffer.byteLength(JSON.stringify(response.tools)) + 1024;
    if (this.#bytes() + reservedBytes >= this.#policy.cleanupThresholdBytes) {
      this.cleanup(Math.max(0, this.#policy.cleanupThresholdBytes - reservedBytes));
    }
    if (this.#bytes() + reservedBytes < this.#policy.hardLimitBytes) return true;
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

  completeJson(id: string, status: 'completed' | 'incomplete', outputText: string, output: OutputItem[], attempt: AttemptCompletion, usage: ResponsesUsage) {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      for (const [outputIndex, item] of output.entries()) this.appendOutputItem(id, outputIndex, item);
      this.#db.prepare('UPDATE attempts SET finished_at = ?, result = ?, pre_output_failure = ?, error_code = ? WHERE id = ?')
        .run(Date.now(), attempt.result, Number(attempt.preOutputFailure), attempt.errorCode ?? null, attempt.id);
      this.#db.prepare('UPDATE responses SET status = ?, output_text = ?, usage_json = ?, incomplete_reason = ?, terminal_at = COALESCE(terminal_at, ?) WHERE id = ?')
        .run(status, outputText, JSON.stringify(usage), status === 'incomplete' ? 'max_output_tokens' : null, Date.now(), id);
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  cancelJson(id: string) {
    this.#db.prepare("UPDATE responses SET status = 'cancelled', terminal_at = COALESCE(terminal_at, ?) WHERE id = ?")
      .run(Date.now(), id);
  }

  jsonResponse(id: string) {
    const row = this.#db.prepare('SELECT id, status, model, usage_json, incomplete_reason FROM responses WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row || (row.status !== 'completed' && row.status !== 'incomplete')) return undefined;
    const output = this.#db.prepare('SELECT item_json FROM output_items WHERE response_id = ? ORDER BY output_index')
      .all(id).map((item) => JSON.parse(String(item.item_json)) as OutputItem);
    return {
      id: String(row.id), object: 'response', status: String(row.status), model: String(row.model), output,
      usage: row.usage_json ? JSON.parse(String(row.usage_json)) as ResponsesUsage : zeroResponsesUsage,
      ...(row.status === 'incomplete' ? { incomplete_details: { reason: String(row.incomplete_reason ?? 'max_output_tokens') } } : {}),
    };
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

  terminal(id: string, status: 'completed' | 'failed' | 'cancelled' | 'incomplete', outputText: string, event: ResponseEvent, attempt?: AttemptCompletion, usage?: ResponsesUsage): StoredEvent {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      if (attempt) {
        this.#db.prepare(
          'UPDATE attempts SET finished_at = ?, result = ?, pre_output_failure = ?, error_code = ? WHERE id = ?',
        ).run(Date.now(), attempt.result, Number(attempt.preOutputFailure), attempt.errorCode ?? null, attempt.id);
      }
      this.#db.prepare('UPDATE responses SET status = ?, output_text = ?, usage_json = COALESCE(?, usage_json), incomplete_reason = ?, terminal_at = COALESCE(terminal_at, ?) WHERE id = ?')
        .run(status, outputText, usage ? JSON.stringify(usage) : null, status === 'incomplete' ? 'max_output_tokens' : null, Date.now(), id);
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
        'SELECT id, parent_id, status, model, input_json, tools_json, parallel_tool_calls, context_complete FROM responses WHERE id = ?',
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
    ).all(id, after).map((row) => {
      const event = JSON.parse(String(row.payload)) as ResponseEvent;
      const response = event.response;
      if ((event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'response.failed')
        && response && typeof response === 'object' && !('usage' in response)) {
        return { sequence: Number(row.sequence), event: { ...event, response: { ...response, usage: this.#usageFor(id) } } };
      }
      return { sequence: Number(row.sequence), event };
    });
  }

  #usageFor(id: string): ResponsesUsage {
    const row = this.#db.prepare('SELECT usage_json FROM responses WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row?.usage_json ? JSON.parse(String(row.usage_json)) as ResponsesUsage : zeroResponsesUsage;
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

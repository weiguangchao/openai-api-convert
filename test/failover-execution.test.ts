import assert from 'node:assert/strict';
import test from 'node:test';
import { buildToolContext } from '../src/adapter.js';
import {
  executeFailover,
  type StreamEventSink,
  type UpstreamStream,
  type UpstreamStreamEvent,
  type UpstreamStreamOutcome,
} from '../src/failover-execution.js';
import type { AttemptCompletion, OutputItem, ResponseEvent, Upstream } from '../src/types.js';

const upstream = (name: string): Upstream => ({ baseUrl: `https://${name}.example`, apiKey: `${name}-key` });
const noCapabilities = { functionTools: false, parallelToolCalls: false };
const textStream = (text: string) => async function* (): AsyncIterable<UpstreamStreamEvent> {
  yield {
    kind: 'event', outputStarted: true, outputText: text,
    event: { type: 'response.output_text.delta', item_id: 'msg_resp_test', output_index: 0, content_index: 0, delta: text },
  };
  yield {
    kind: 'completed', status: 'completed', usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } }, eventsBeforeOutputItems: [], outputText: text,
    output: [{ id: 'msg_resp_test', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text }] }],
  };
};

type Script =
  | { kind: 'unavailable' }
  | { kind: 'rejected' }
  | { kind: 'stream'; events: (signal: AbortSignal) => AsyncIterable<UpstreamStreamEvent> };

class ScriptedUpstreamStream implements UpstreamStream {
  calls: string[] = [];
  #scripts: Script[];

  constructor(scripts: Script[]) {
    this.#scripts = scripts;
  }

  async open({ upstream: selected }: { upstream: Upstream }, signal: AbortSignal): Promise<UpstreamStreamOutcome> {
    this.calls.push(selected.baseUrl);
    const script = this.#scripts.shift();
    if (!script) throw new Error('Unexpected upstream call');
    if (script.kind !== 'stream') return script;
    return { kind: 'stream', events: script.events(signal) };
  }
}

class RecordingSink implements StreamEventSink {
  events: ResponseEvent[] = [];
  output: OutputItem[] = [];
  attempts: AttemptCompletion[] = [];
  operations: string[] = [];
  terminalRecord: { status: string; event: ResponseEvent; attempt: AttemptCompletion | undefined } | undefined;
  onEmit: ((event: ResponseEvent) => void) | undefined;
  #nextAttemptId = 1;

  startAttempt() {
    return this.#nextAttemptId++;
  }

  finishAttempt(attempt: AttemptCompletion) {
    this.attempts.push(attempt);
    this.operations.push(`finish:${attempt.result}:${attempt.errorCode ?? ''}`);
  }

  emit(event: ResponseEvent) {
    this.events.push(event);
    this.operations.push(`emit:${event.type}`);
    this.onEmit?.(event);
  }

  emitOutputItems(output: OutputItem[]) {
    for (const item of output) {
      this.output.push(item);
      this.operations.push(`persist:${item.id}`);
      this.emit({ type: 'response.output_item.done', output_index: this.output.length - 1, item });
    }
  }

  terminal(status: 'completed' | 'failed' | 'cancelled', _outputText: string, event: ResponseEvent, attempt: AttemptCompletion | undefined) {
    this.terminalRecord = { status, event, attempt };
    this.operations.push(`terminal:${status}`);
  }
}

const run = (scripts: Script[], sink = new RecordingSink(), signal?: AbortSignal) => ({
  sink,
  result: executeFailover({
    responseId: 'resp_test', model: 'test-model', upstreamBody: { stream: true },
    upstreams: [upstream('primary'), upstream('fallback')], needs: noCapabilities, firstEventTimeoutMs: 1_000, outputIdleTimeoutMs: 1_000,
  }, new ScriptedUpstreamStream(scripts), sink, signal),
});

test('Failover Policy Execution completes through scripted Upstream Stream and records Output Items before done events', async () => {
  const { sink, result } = run([{ kind: 'stream', events: () => textStream('Hello')() }]);

  assert.deepEqual(await result, { kind: 'completed' });
  assert.deepEqual(sink.events.map(({ type }) => type), ['response.created', 'response.in_progress', 'response.output_text.delta', 'response.output_item.done']);
  assert.deepEqual(sink.output, [{
    id: 'msg_resp_test', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'Hello' }],
  }]);
  assert.equal(sink.operations.indexOf('persist:msg_resp_test') < sink.operations.indexOf('emit:response.output_item.done'), true);
  assert.deepEqual(sink.terminalRecord, {
    status: 'completed',
    event: { type: 'response.completed', response: {
      id: 'resp_test', object: 'response', status: 'completed', model: 'test-model', output: sink.output,
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
    } },
    attempt: { id: 1, result: 'completed', preOutputFailure: false },
  });
  assert.equal(sink.operations.includes('emit:response.completed'), false, 'terminal event and final Attempt are one atomic sink operation');
});

test('Failover Policy Execution retries an unavailable Upstream before the first Stream Event', async () => {
  const scripts: Script[] = [
    { kind: 'unavailable' },
    { kind: 'stream', events: () => textStream('fallback')() },
  ];
  const stream = new ScriptedUpstreamStream(scripts);
  const sink = new RecordingSink();

  assert.deepEqual(await executeFailover({
    responseId: 'resp_test', model: 'test-model', upstreamBody: {},
    upstreams: [upstream('primary'), upstream('fallback')], needs: noCapabilities, firstEventTimeoutMs: 1_000, outputIdleTimeoutMs: 1_000,
  }, stream, sink), { kind: 'completed' });
  assert.deepEqual(stream.calls, ['https://primary.example', 'https://fallback.example']);
  assert.deepEqual(sink.attempts, [{ id: 1, result: 'failed', preOutputFailure: true, errorCode: 'upstream_retryable' }]);
  assert.equal(sink.terminalRecord?.attempt?.id, 2);
});

test('Failover Policy Execution returns a pre-output rejection without Stream Events', async () => {
  const { sink, result } = run([{ kind: 'rejected' }]);

  assert.deepEqual(await result, { kind: 'pre_output_failure', reason: 'rejected' });
  assert.deepEqual(sink.events, []);
  assert.deepEqual(sink.attempts, [{ id: 1, result: 'failed', preOutputFailure: true, errorCode: 'upstream_rejected' }]);
  assert.equal(sink.terminalRecord, undefined);
});

test('Failover Policy Execution retries when a heartbeat arrives before any semantic Stream Event', async () => {
  const stream = new ScriptedUpstreamStream([
    { kind: 'stream', events: () => (async function* (): AsyncIterable<UpstreamStreamEvent> {
      yield { kind: 'heartbeat' };
      throw new Error('malformed upstream frame');
    })() },
    { kind: 'stream', events: () => textStream('fallback')() },
  ]);
  const sink = new RecordingSink();

  assert.deepEqual(await executeFailover({
    responseId: 'resp_test', model: 'test-model', upstreamBody: {},
    upstreams: [upstream('primary'), upstream('fallback')], needs: noCapabilities, firstEventTimeoutMs: 1_000, outputIdleTimeoutMs: 1_000,
  }, stream, sink), { kind: 'completed' });
  assert.deepEqual(stream.calls, ['https://primary.example', 'https://fallback.example']);
  assert.deepEqual(sink.attempts, [{ id: 1, result: 'failed', preOutputFailure: true, errorCode: 'upstream_retryable' }]);
  assert.deepEqual(sink.events.map(({ type }) => type), ['response.created', 'response.in_progress', 'response.output_text.delta', 'response.output_item.done']);
});

test('Failover Policy Execution rejects incompatible pools without creating an Attempt', async () => {
  const stream = new ScriptedUpstreamStream([]);
  const sink = new RecordingSink();

  assert.deepEqual(await executeFailover({
    responseId: 'resp_test', model: 'test-model', upstreamBody: {},
    upstreams: [upstream('primary')],
    needs: { functionTools: true, parallelToolCalls: false },
    firstEventTimeoutMs: 1_000, outputIdleTimeoutMs: 1_000,
  }, stream, sink), { kind: 'pre_output_failure', reason: 'unsupported_capabilities' });
  assert.deepEqual(stream.calls, []);
  assert.deepEqual(sink.attempts, []);
  assert.deepEqual(sink.events, []);
});

test('Failover Policy Execution returns unavailable when every upstream fails before the first Stream Event', async () => {
  const { sink, result } = run([
    { kind: 'unavailable' },
    { kind: 'unavailable' },
  ]);

  assert.deepEqual(await result, { kind: 'pre_output_failure', reason: 'unavailable' });
  assert.deepEqual(sink.events, []);
  assert.deepEqual(sink.attempts.map(({ errorCode }) => errorCode), ['upstream_retryable', 'upstream_retryable']);
});

test('Failover Policy Execution fails after the first Stream Event without switching upstreams', async () => {
  const stream = new ScriptedUpstreamStream([
    { kind: 'stream', events: () => (async function* (): AsyncIterable<UpstreamStreamEvent> {
      yield {
        kind: 'event', outputStarted: true, outputText: 'partial',
        event: { type: 'response.output_text.delta', item_id: 'msg_resp_test', output_index: 0, content_index: 0, delta: 'partial' },
      };
      throw new Error('stream ended');
    })() },
    { kind: 'stream', events: () => textStream('fallback')() },
  ]);
  const sink = new RecordingSink();

  assert.deepEqual(await executeFailover({
    responseId: 'resp_test', model: 'test-model', upstreamBody: {},
    upstreams: [upstream('primary'), upstream('fallback')], needs: noCapabilities, firstEventTimeoutMs: 1_000, outputIdleTimeoutMs: 1_000,
  }, stream, sink), { kind: 'failed' });
  assert.deepEqual(stream.calls, ['https://primary.example']);
  assert.deepEqual(sink.events.map(({ type }) => type), ['response.created', 'response.in_progress', 'response.output_text.delta']);
  assert.equal(sink.terminalRecord?.status, 'failed');
  assert.deepEqual(sink.terminalRecord?.attempt, { id: 1, result: 'failed', preOutputFailure: false, errorCode: 'upstream_stream_failed' });
});

test('Failover Policy Execution retains a normalized SSE error and terminal usage', async () => {
  const stream = new ScriptedUpstreamStream([
    { kind: 'stream', events: () => (async function* (): AsyncIterable<UpstreamStreamEvent> {
      yield {
        kind: 'event', outputStarted: true, outputText: 'partial',
        usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5, input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 1 } },
        event: { type: 'response.output_text.delta', item_id: 'msg_resp_test', output_index: 0, content_index: 0, delta: 'partial' },
      };
      yield {
        kind: 'failed', outputText: 'partial', usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5, input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 1 } },
        error: { status: 502, message: 'Bad upstream event', type: 'upstream_error', param: 'tools', code: 'bad_event' },
      };
    })() },
  ]);
  const sink = new RecordingSink();

  assert.deepEqual(await executeFailover({
    responseId: 'resp_test', model: 'test-model', upstreamBody: {},
    upstreams: [upstream('primary')], needs: noCapabilities, firstEventTimeoutMs: 1_000, outputIdleTimeoutMs: 1_000,
  }, stream, sink), { kind: 'failed' });
  assert.deepEqual((sink.terminalRecord?.event as unknown as { response: { error: unknown; usage: unknown } }).response, {
    id: 'resp_test', object: 'response', status: 'failed',
    usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5, input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 1 } },
    error: { message: 'Bad upstream event', type: 'upstream_error', param: 'tools', code: 'bad_event' },
  });
  assert.deepEqual(sink.terminalRecord?.attempt, { id: 1, result: 'failed', preOutputFailure: false, errorCode: 'bad_event' });
});

test('Failover Policy Execution keeps a pre-output SSE error as a pre-output failure', async () => {
  const stream = new ScriptedUpstreamStream([
    { kind: 'stream', events: () => (async function* (): AsyncIterable<UpstreamStreamEvent> {
      yield {
        kind: 'failed', outputText: '', usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
        error: { status: 502, message: 'Bad upstream event', type: 'upstream_error', param: null, code: 'bad_event' },
      };
    })() },
  ]);
  const sink = new RecordingSink();

  assert.deepEqual(await executeFailover({
    responseId: 'resp_test', model: 'test-model', upstreamBody: {},
    upstreams: [upstream('primary')], needs: noCapabilities, firstEventTimeoutMs: 1_000, outputIdleTimeoutMs: 1_000,
  }, stream, sink), {
    kind: 'pre_output_failure', reason: 'rejected', status: 502,
    error: { status: 502, message: 'Bad upstream event', type: 'upstream_error', param: null, code: 'bad_event' },
  });
  assert.deepEqual(sink.events, []);
  assert.deepEqual(sink.attempts, [{ id: 1, result: 'failed', preOutputFailure: true, errorCode: 'bad_event' }]);
  assert.equal(sink.terminalRecord, undefined);
});

test('Failover Policy Execution cancels the active upstream and terminates the Response as cancelled', async () => {
  const controller = new AbortController();
  const sink = new RecordingSink();
  sink.onEmit = (event) => { if (event.type === 'response.output_text.delta') controller.abort(); };
  const pendingUntilCancelled = async function* (signal: AbortSignal): AsyncIterable<UpstreamStreamEvent> {
    yield {
      kind: 'event', outputStarted: true, outputText: 'partial',
      event: { type: 'response.output_text.delta', item_id: 'msg_resp_test', output_index: 0, content_index: 0, delta: 'partial' },
    };
    await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  };

  const { result } = run([{ kind: 'stream', events: pendingUntilCancelled }], sink, controller.signal);
  assert.deepEqual(await result, { kind: 'cancelled' });
  assert.equal(sink.terminalRecord?.status, 'cancelled');
  assert.deepEqual(sink.terminalRecord?.attempt, { id: 1, result: 'cancelled', preOutputFailure: false, errorCode: 'client_disconnected' });
});

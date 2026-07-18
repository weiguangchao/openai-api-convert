import type { AttemptCompletion, CapabilityProfile, OutputItem, ResponseEvent, Result, Upstream } from './types.js';

export type ExecutionNeeds = Required<CapabilityProfile>;
export type UpstreamStreamRequest = { upstream: Upstream; responseId: string; upstreamBody: Record<string, unknown>; attemptIndex: number };
export type UpstreamStreamOutcome =
  | { kind: 'stream'; events: AsyncIterable<UpstreamStreamEvent> }
  | { kind: 'unavailable' }
  | { kind: 'rejected' };

export type UpstreamStreamEvent =
  | { kind: 'heartbeat' }
  | { kind: 'event'; event: ResponseEvent; outputStarted: boolean; outputText: string }
  | { kind: 'completed'; eventsBeforeOutputItems: ResponseEvent[]; output: OutputItem[]; outputText: string };

export interface UpstreamStream {
  open(request: UpstreamStreamRequest, signal: AbortSignal): Promise<UpstreamStreamOutcome>;
}

export interface StreamEventSink {
  startAttempt(attemptIndex: number): number;
  finishAttempt(attempt: AttemptCompletion): void;
  emit(event: ResponseEvent): void;
  emitOutputItems(output: OutputItem[]): void;
  terminal(status: 'completed' | 'failed' | 'cancelled', outputText: string, event: ResponseEvent, attempt: AttemptCompletion | undefined): void;
}

export type FailoverExecutionInput = {
  responseId: string;
  model: string;
  upstreamBody: Record<string, unknown>;
  upstreams: Upstream[];
  firstEventTimeoutMs: number;
  outputIdleTimeoutMs: number;
};

export type FailoverExecutionOutcome =
  | { kind: 'completed' }
  | { kind: 'failed' }
  | { kind: 'cancelled' }
  | { kind: 'pre_output_failure'; reason: 'rejected' | 'unavailable' };

export const planFailoverExecution = (upstreams: Upstream[], needs: ExecutionNeeds): Result<Upstream[]> => {
  const compatible = upstreams.filter((upstream) => (
    (!needs.functionTools || upstream.capabilities?.functionTools === true)
    && (!needs.customTools || upstream.capabilities?.customTools === true)
    && (!needs.parallelToolCalls || upstream.capabilities?.parallelToolCalls === true)
  ));
  if (!compatible.length) {
    return { ok: false, error: { status: 400, message: 'No upstream supports the requested capabilities', code: 'unsupported_capabilities' } };
  }
  return { ok: true, value: compatible };
};

export const executeFailover = async (
  input: FailoverExecutionInput,
  upstreamStream: UpstreamStream,
  sink: StreamEventSink,
  cancelled?: AbortSignal,
): Promise<FailoverExecutionOutcome> => {
  let streamStarted = false;
  let attemptIndex = 0;
  let failedOutputText = '';
  let retryAttempt: AttemptCompletion | undefined;

  const cancel = (attempt: AttemptCompletion | undefined, outputText: string) => {
    sink.terminal('cancelled', outputText, {
      type: 'response.cancelled', response: { id: input.responseId, object: 'response', status: 'cancelled' },
    }, attempt);
    return { kind: 'cancelled' } as const;
  };

  for (const upstream of input.upstreams) {
    if (cancelled?.aborted) return cancel(retryAttempt, failedOutputText);
    attemptIndex += 1;
    const attemptId = sink.startAttempt(attemptIndex);
    const abort = new AbortController();
    const onCancel = () => abort.abort();
    cancelled?.addEventListener('abort', onCancel, { once: true });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const clearTimeoutForAttempt = () => {
      if (timeout) clearTimeout(timeout);
      timeout = undefined;
    };
    const armTimeout = (milliseconds: number) => {
      clearTimeoutForAttempt();
      timeout = setTimeout(() => abort.abort(), milliseconds);
    };
    const retry = (errorCode: string) => {
      const attempt: AttemptCompletion = { id: attemptId, result: 'failed', preOutputFailure: true, errorCode };
      sink.finishAttempt(attempt);
      retryAttempt = attempt;
    };
    let attemptOutputText = '';

    try {
      armTimeout(input.firstEventTimeoutMs);
      const outcome = await upstreamStream.open({ upstream, responseId: input.responseId, upstreamBody: input.upstreamBody, attemptIndex }, abort.signal);
      if (cancelled?.aborted) return cancel({ id: attemptId, result: 'cancelled', preOutputFailure: !streamStarted, errorCode: 'client_disconnected' }, failedOutputText);
      if (outcome.kind === 'unavailable') {
        retry('upstream_retryable');
        continue;
      }
      if (outcome.kind === 'rejected') {
        retry('upstream_rejected');
        return { kind: 'pre_output_failure', reason: 'rejected' };
      }

      let completed = false;
      for await (const streamEvent of outcome.events) {
        clearTimeoutForAttempt();
        if (!streamStarted) {
          sink.emit({
            type: 'response.created', response: { id: input.responseId, object: 'response', status: 'in_progress', model: input.model, output: [] },
          });
          streamStarted = true;
        }
        if (streamEvent.kind === 'completed') {
          for (const event of streamEvent.eventsBeforeOutputItems) sink.emit(event);
          sink.emitOutputItems(streamEvent.output);
          sink.terminal('completed', streamEvent.outputText, {
            type: 'response.completed', response: {
              id: input.responseId, object: 'response', status: 'completed', model: input.model, output: streamEvent.output,
            },
          }, { id: attemptId, result: 'completed', preOutputFailure: false });
          completed = true;
          break;
        }
        if (streamEvent.kind === 'heartbeat') continue;
        sink.emit(streamEvent.event);
        attemptOutputText = streamEvent.outputText;
        failedOutputText = attemptOutputText;
        if (cancelled?.aborted) {
          return cancel({ id: attemptId, result: 'cancelled', preOutputFailure: !streamStarted, errorCode: 'client_disconnected' }, attemptOutputText);
        }
        if (streamEvent.outputStarted) armTimeout(input.outputIdleTimeoutMs);
      }
      if (!completed) throw new Error('Upstream stream ended without [DONE]');
      return { kind: 'completed' };
    } catch {
      if (cancelled?.aborted) {
        return cancel({ id: attemptId, result: 'cancelled', preOutputFailure: !streamStarted, errorCode: 'client_disconnected' }, attemptOutputText);
      }
      if (!streamStarted) {
        retry('upstream_retryable');
        continue;
      }
      const outputText = failedOutputText || '';
      sink.terminal('failed', outputText, {
        type: 'response.failed', response: { id: input.responseId, object: 'response', status: 'failed' },
      }, { id: attemptId, result: 'failed', preOutputFailure: false, errorCode: 'upstream_stream_failed' });
      return { kind: 'failed' };
    } finally {
      clearTimeoutForAttempt();
      cancelled?.removeEventListener('abort', onCancel);
    }
  }

  if (cancelled?.aborted) return cancel(retryAttempt, failedOutputText);
  return { kind: 'pre_output_failure', reason: 'unavailable' };
};

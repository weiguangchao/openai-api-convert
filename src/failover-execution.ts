import type { AppError, AttemptCompletion, CapabilityProfile, OutputItem, ResponseEvent, ResponsesUsage, Result, Upstream } from './types.js';

export type ExecutionNeeds = Required<CapabilityProfile>;
export type UpstreamStreamRequest = { upstream: Upstream; responseId: string; upstreamBody: Record<string, unknown>; attemptIndex: number };
export type UpstreamStreamOutcome =
  | { kind: 'stream'; events: AsyncIterable<UpstreamStreamEvent> }
  | { kind: 'unavailable' }
  | { kind: 'rejected'; status?: number; error?: AppError };

export type UpstreamStreamEvent =
  | { kind: 'heartbeat'; usage?: ResponsesUsage }
  | { kind: 'event'; event: ResponseEvent; outputStarted: boolean; outputText: string; usage?: ResponsesUsage }
  | { kind: 'failed'; error: AppError; outputText: string; usage: ResponsesUsage }
  | { kind: 'completed'; status: 'completed' | 'incomplete'; eventsBeforeOutputItems: ResponseEvent[]; output: OutputItem[]; outputText: string; usage: ResponsesUsage };

export interface UpstreamStream {
  open(request: UpstreamStreamRequest, signal: AbortSignal): Promise<UpstreamStreamOutcome>;
}

export type UpstreamJsonOutcome =
  | { kind: 'completion'; completion: unknown }
  | { kind: 'unavailable' }
  | { kind: 'rejected'; status: number; error?: AppError };

export interface UpstreamJson {
  complete(request: UpstreamStreamRequest, signal: AbortSignal): Promise<UpstreamJsonOutcome>;
}

export interface JsonExecutionSink {
  startAttempt(attemptIndex: number): number;
  finishAttempt(attempt: AttemptCompletion): void;
}

export type JsonFailoverExecutionOutcome =
  | { kind: 'completed'; completion: unknown; attempt: AttemptCompletion }
  | { kind: 'cancelled'; attempt?: AttemptCompletion }
  | { kind: 'pre_output_failure'; reason: 'rejected' | 'unavailable' | 'unsupported_capabilities'; status?: number; error?: AppError };

export interface StreamEventSink {
  startAttempt(attemptIndex: number): number;
  finishAttempt(attempt: AttemptCompletion): void;
  emit(event: ResponseEvent): void;
  emitOutputItems(output: OutputItem[]): void;
  terminal(status: 'completed' | 'failed' | 'cancelled' | 'incomplete', outputText: string, event: ResponseEvent, attempt: AttemptCompletion | undefined, usage?: ResponsesUsage): void;
}

export type FailoverExecutionInput = {
  responseId: string;
  model: string;
  upstreamBody: Record<string, unknown>;
  upstreams: Upstream[];
  needs: ExecutionNeeds;
  firstEventTimeoutMs: number;
  outputIdleTimeoutMs: number;
};

export type FailoverExecutionOutcome =
  | { kind: 'completed' }
  | { kind: 'failed' }
  | { kind: 'cancelled' }
  | { kind: 'pre_output_failure'; reason: 'rejected' | 'unavailable' | 'unsupported_capabilities'; status?: number; error?: AppError };

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
  const planned = planFailoverExecution(input.upstreams, input.needs);
  if (!planned.ok) return { kind: 'pre_output_failure', reason: 'unsupported_capabilities' };
  let streamStarted = false;
  let attemptIndex = 0;
  let failedOutputText = '';
  let failedUsage: ResponsesUsage = { input_tokens: 0, output_tokens: 0, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
  let retryAttempt: AttemptCompletion | undefined;

  const cancel = (attempt: AttemptCompletion | undefined, outputText: string) => {
    sink.terminal('cancelled', outputText, {
      type: 'response.cancelled', response: { id: input.responseId, object: 'response', status: 'cancelled' },
    }, attempt);
    return { kind: 'cancelled' } as const;
  };

  for (const upstream of planned.value) {
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
        return { kind: 'pre_output_failure', reason: 'rejected', ...(outcome.status === undefined ? {} : { status: outcome.status }), ...(outcome.error === undefined ? {} : { error: outcome.error }) };
      }

      let completed = false;
      for await (const streamEvent of outcome.events) {
        clearTimeoutForAttempt();
        if (streamEvent.kind === 'heartbeat') {
          if (streamEvent.usage) failedUsage = streamEvent.usage;
          continue;
        }
        if (streamEvent.kind === 'failed' && !streamStarted) {
          sink.finishAttempt({ id: attemptId, result: 'failed', preOutputFailure: true, errorCode: streamEvent.error.code });
          return { kind: 'pre_output_failure', reason: 'rejected', status: streamEvent.error.status, error: streamEvent.error };
        }
        if (!streamStarted) {
          sink.emit({
            type: 'response.created', response: { id: input.responseId, object: 'response', status: 'in_progress', model: input.model, output: [] },
          });
          sink.emit({ type: 'response.in_progress', response: { id: input.responseId, object: 'response', status: 'in_progress', model: input.model, output: [] } });
          streamStarted = true;
        }
        if (streamEvent.kind === 'completed') {
          for (const event of streamEvent.eventsBeforeOutputItems) sink.emit(event);
          sink.emitOutputItems(streamEvent.output);
          sink.terminal(streamEvent.status, streamEvent.outputText, {
            type: streamEvent.status === 'incomplete' ? 'response.incomplete' : 'response.completed', response: {
              id: input.responseId, object: 'response', status: streamEvent.status, model: input.model, output: streamEvent.output, usage: streamEvent.usage,
              ...(streamEvent.status === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
            },
          }, { id: attemptId, result: 'completed', preOutputFailure: false }, streamEvent.usage);
          completed = true;
          break;
        }
        if (streamEvent.kind === 'failed') {
          failedUsage = streamEvent.usage;
          sink.terminal('failed', streamEvent.outputText, {
            type: 'response.failed', response: {
              id: input.responseId, object: 'response', status: 'failed', usage: streamEvent.usage,
              error: { message: streamEvent.error.message, type: streamEvent.error.type ?? 'server_error', param: streamEvent.error.param ?? null, code: streamEvent.error.code },
            },
          }, { id: attemptId, result: 'failed', preOutputFailure: false, errorCode: streamEvent.error.code }, streamEvent.usage);
          return { kind: 'failed' };
        }
        sink.emit(streamEvent.event);
        attemptOutputText = streamEvent.outputText;
        failedOutputText = attemptOutputText;
        if (streamEvent.usage) failedUsage = streamEvent.usage;
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
        type: 'response.failed', response: {
          id: input.responseId, object: 'response', status: 'failed',
          usage: failedUsage,
          error: { message: 'Upstream stream failed', type: 'server_error', param: null, code: 'upstream_stream_failed' },
        },
      }, { id: attemptId, result: 'failed', preOutputFailure: false, errorCode: 'upstream_stream_failed' }, failedUsage);
      return { kind: 'failed' };
    } finally {
      clearTimeoutForAttempt();
      cancelled?.removeEventListener('abort', onCancel);
    }
  }

  if (cancelled?.aborted) return cancel(retryAttempt, failedOutputText);
  return { kind: 'pre_output_failure', reason: 'unavailable' };
};

export const executeJsonFailover = async (
  input: FailoverExecutionInput,
  upstreamJson: UpstreamJson,
  sink: JsonExecutionSink,
  cancelled?: AbortSignal,
): Promise<JsonFailoverExecutionOutcome> => {
  const planned = planFailoverExecution(input.upstreams, input.needs);
  if (!planned.ok) return { kind: 'pre_output_failure', reason: 'unsupported_capabilities' };
  let attemptIndex = 0;
  for (const upstream of planned.value) {
    if (cancelled?.aborted) return { kind: 'cancelled' };
    attemptIndex += 1;
    const attemptId = sink.startAttempt(attemptIndex);
    const abort = new AbortController();
    const onCancel = () => abort.abort();
    cancelled?.addEventListener('abort', onCancel, { once: true });
    try {
      const outcome = await upstreamJson.complete({ upstream, responseId: input.responseId, upstreamBody: input.upstreamBody, attemptIndex }, abort.signal);
      if (cancelled?.aborted) {
        const attempt = { id: attemptId, result: 'cancelled' as const, preOutputFailure: true, errorCode: 'client_disconnected' };
        sink.finishAttempt(attempt);
        return { kind: 'cancelled', attempt };
      }
      if (outcome.kind === 'completion') return { kind: 'completed', completion: outcome.completion, attempt: { id: attemptId, result: 'completed', preOutputFailure: false } };
      if (outcome.kind === 'rejected') {
        sink.finishAttempt({ id: attemptId, result: 'failed', preOutputFailure: true, errorCode: 'upstream_rejected' });
        return { kind: 'pre_output_failure', reason: 'rejected', status: outcome.status, error: outcome.error };
      }
      sink.finishAttempt({ id: attemptId, result: 'failed', preOutputFailure: true, errorCode: 'upstream_retryable' });
    } catch {
      if (cancelled?.aborted) {
        const attempt = { id: attemptId, result: 'cancelled' as const, preOutputFailure: true, errorCode: 'client_disconnected' };
        sink.finishAttempt(attempt);
        return { kind: 'cancelled', attempt };
      }
      sink.finishAttempt({ id: attemptId, result: 'failed', preOutputFailure: true, errorCode: 'upstream_retryable' });
    } finally {
      cancelled?.removeEventListener('abort', onCancel);
    }
  }
  return { kind: 'pre_output_failure', reason: 'unavailable' };
};

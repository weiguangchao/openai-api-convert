import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AttemptCompletion, RequestContext, ResponseEvent, Upstream } from './types.js';
import { type NamespaceAliases } from './adapter.js';
import { attemptUpstream, type CancelState, type AttemptCounter } from './attempt.js';
import { finishUpstreamFailure, terminalSse } from './sse.js';
import { setErrorCode } from './http.js';

export type StreamUpstreamParams = { responseId: string; model: string; upstreamBody: Record<string, unknown>; namespaceAliases: NamespaceAliases; upstreams: Upstream[] };

export const streamUpstreamAttempts = async (ctx: RequestContext, request: IncomingMessage, response: ServerResponse, requestId: string, params: StreamUpstreamParams) => {
  const { options, state, logging } = ctx;
  const { responseId: id, model, upstreamBody, namespaceAliases, upstreams } = params;
  let streamStarted = false;
  const cancelState: CancelState = { cancelled: false, activeAbort: undefined };
  let failedOutputText = '';
  const cancel = () => { setErrorCode(response, 'client_disconnected'); cancelState.cancelled = true; cancelState.activeAbort?.abort(); };
  const onResponseClose = () => { if (!response.writableEnded) cancel(); };
  request.once('aborted', cancel);
  response.once('close', onResponseClose);
  try {
    const upstreamAttempts: AttemptCounter = { value: 0 };
    let terminalAttempt: AttemptCompletion | undefined;
    let retryAttempt: AttemptCompletion | undefined;
    const logDownstreamOutbound = (event: ResponseEvent) => {
      logging.log('info', 'traffic_downstream_outbound', { requestId, responseId: id, attempt_index: upstreamAttempts.value, event_type: event.type });
      if (logging.level === 'debug') {
        logging.log('debug', 'traffic_downstream_outbound', { requestId, responseId: id, attempt_index: upstreamAttempts.value, event_type: event.type, sse_event: event });
      }
    };
    for (const upstream of upstreams) {
      if (cancelState.cancelled) break;
      if (retryAttempt) {
        state.finishAttempt(retryAttempt);
        retryAttempt = undefined;
      }
      const outcome = await attemptUpstream(ctx, response, requestId, {
        upstream, id, model, upstreamBody, namespaceAliases, upstreamAttempts, cancelState, streamStarted, logDownstreamOutbound,
      });
      if (outcome.outcome === 'completed') return;
      if (outcome.outcome === 'rejected') return;
      if (outcome.outcome === 'retryable') {
        retryAttempt = outcome.attempt;
        streamStarted = outcome.streamStarted;
        continue;
      }
      terminalAttempt = outcome.attempt;
      failedOutputText = outcome.failedOutputText;
      streamStarted = outcome.streamStarted;
      break;
    }
    if (cancelState.cancelled) {
      const cancelledAttempt = terminalAttempt ?? (retryAttempt && { ...retryAttempt, result: 'cancelled' as const, errorCode: 'client_disconnected' });
      state.terminal(id, 'cancelled', failedOutputText, { type: 'response.cancelled', response: { id, object: 'response', status: 'cancelled' } }, cancelledAttempt);
      if (!response.destroyed) response.end();
      return;
    }
    if (!streamStarted) {
      finishUpstreamFailure(response, state, id, 503, 'Upstream unavailable', 'upstream_unavailable');
      return;
    }
    setErrorCode(response, 'upstream_stream_failed');
    terminalSse(response, state, id, 'failed', failedOutputText, { type: 'response.failed', response: { id, object: 'response', status: 'failed' } }, terminalAttempt ?? retryAttempt, logDownstreamOutbound);
    response.end();
  } finally {
    request.removeListener('aborted', cancel);
    response.removeListener('close', onResponseClose);
  }
};

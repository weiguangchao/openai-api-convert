import type { ServerResponse } from 'node:http';
import type { AttemptCompletion, RequestContext, ResponseEvent, Upstream } from './types.ts';
import { StreamTranslator, type NamespaceAliases } from './adapter.ts';
import { finishUpstreamFailure, parseUpstream, sse, terminalSse } from './sse.ts';
import { redactHeaders } from './http.ts';

export type CancelState = { cancelled: boolean; activeAbort: AbortController | undefined };
export type AttemptCounter = { value: number };
type AttemptUpstreamParams = {
  upstream: Upstream; id: string; model: string; upstreamBody: Record<string, unknown>; namespaceAliases: NamespaceAliases;
  upstreamAttempts: AttemptCounter; cancelState: CancelState; streamStarted: boolean; logDownstreamOutbound: (event: ResponseEvent) => void;
};
type AttemptOutcome =
  | { outcome: 'completed' }
  | { outcome: 'rejected' }
  | { outcome: 'retryable'; attempt: AttemptCompletion; streamStarted: boolean }
  | { outcome: 'terminal'; attempt: AttemptCompletion; failedOutputText: string; streamStarted: boolean };

export const attemptUpstream = async (ctx: RequestContext, response: ServerResponse, requestId: string, params: AttemptUpstreamParams): Promise<AttemptOutcome> => {
  const { options, state, logging, metrics } = ctx;
  const { upstream, id, model, upstreamBody, namespaceAliases, upstreamAttempts, cancelState, logDownstreamOutbound } = params;
  let streamStarted = params.streamStarted;
  const abort = new AbortController();
  cancelState.activeAbort = abort;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const armTimeout = (milliseconds: number) => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => abort.abort(), milliseconds);
  };
  const finishAttempt = () => {
    if (timeout) clearTimeout(timeout);
    cancelState.activeAbort = undefined;
  };
  armTimeout(options.firstEventTimeoutMs ?? 30_000);
  const attemptId = state.startAttempt(id);
  if (upstreamAttempts.value > 0) metrics.upstreamSwitches += 1;
  upstreamAttempts.value += 1;
  const upstreamUrl = new URL('/v1/chat/completions', upstream.baseUrl);
  const upstreamHeaders: Record<string, string> = { authorization: `Bearer ${upstream.apiKey}`, 'content-type': 'application/json', accept: 'text/event-stream' };
  logging.log('info', 'traffic_upstream_outbound', { requestId, responseId: id, attempt_index: upstreamAttempts.value });
  if (logging.level === 'debug') {
    logging.log('debug', 'traffic_upstream_outbound', {
      requestId, responseId: id, attempt_index: upstreamAttempts.value,
      upstream_url: upstreamUrl.href,
      headers: redactHeaders(upstreamHeaders),
      body: JSON.stringify(upstreamBody),
    });
  }
  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(upstreamUrl, {
      method: 'POST',
      headers: upstreamHeaders,
      body: JSON.stringify(upstreamBody), signal: abort.signal,
    });
  } catch {
    logging.log('info', 'traffic_upstream_inbound', { requestId, responseId: id, attempt_index: upstreamAttempts.value, status: 0 });
    finishAttempt();
    if (cancelState.cancelled) {
      return { outcome: 'terminal', attempt: { id: attemptId, result: 'cancelled', preOutputFailure: true, errorCode: 'client_disconnected' }, failedOutputText: '', streamStarted };
    }
    return { outcome: 'retryable', attempt: { id: attemptId, result: 'failed', preOutputFailure: true, errorCode: 'upstream_retryable' }, streamStarted };
  }
  logging.log('info', 'traffic_upstream_inbound', { requestId, responseId: id, attempt_index: upstreamAttempts.value, status: upstreamResponse.status });
  if (logging.level === 'debug') {
    logging.log('debug', 'traffic_upstream_inbound', {
      requestId, responseId: id, attempt_index: upstreamAttempts.value, status: upstreamResponse.status,
      headers: redactHeaders(Object.fromEntries(upstreamResponse.headers.entries())),
    });
  }
  if (upstreamResponse.status === 408 || upstreamResponse.status === 429 || upstreamResponse.status >= 500 || !upstreamResponse.body) {
    if (logging.level === 'debug' && upstreamResponse.body) {
      logging.log('debug', 'traffic_upstream_inbound', { requestId, responseId: id, attempt_index: upstreamAttempts.value, body: await upstreamResponse.text() });
    }
    finishAttempt();
    return { outcome: 'retryable', attempt: { id: attemptId, result: 'failed', preOutputFailure: true, errorCode: 'upstream_retryable' }, streamStarted };
  }
  if (upstreamResponse.status >= 400) {
    if (logging.level === 'debug') {
      logging.log('debug', 'traffic_upstream_inbound', { requestId, responseId: id, attempt_index: upstreamAttempts.value, body: await upstreamResponse.text() });
    }
    finishAttempt();
    if (!streamStarted) {
      finishUpstreamFailure(response, state, id, 400, 'Upstream rejected request', 'upstream_rejected');
      return { outcome: 'rejected' };
    }
    return { outcome: 'terminal', attempt: { id: attemptId, result: 'failed', preOutputFailure: true, errorCode: 'upstream_rejected' }, failedOutputText: '', streamStarted };
  }
  if (!streamStarted) {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    sse(response, state, id, { type: 'response.created', response: { id, object: 'response', status: 'in_progress', model, output: [] } }, logDownstreamOutbound);
    streamStarted = true;
  }

  const translator = new StreamTranslator(id, namespaceAliases);
  let firstChunk = true;
  let completed = false;
  try {
    for await (const data of parseUpstream(upstreamResponse.body)) {
      if (logging.level === 'debug') {
        logging.log('debug', 'traffic_upstream_inbound', { requestId, responseId: id, attempt_index: upstreamAttempts.value, body: data });
      }
      if (firstChunk) {
        firstChunk = false;
        if (timeout) clearTimeout(timeout);
        timeout = undefined;
      }
      if (data === '[DONE]') { completed = true; break; }
      for (const event of translator.feed(data)) {
        sse(response, state, id, event, logDownstreamOutbound);
      }
      if (translator.outputStarted) armTimeout(options.outputIdleTimeoutMs ?? 60_000);
    }
    if (!completed) throw new Error('Upstream stream ended without [DONE]');
    const events = translator.finalize();
    for (const [index, item] of translator.output.entries()) {
      state.appendOutputItem(id, index, item);
    }
    for (const event of events) {
      sse(response, state, id, event, logDownstreamOutbound);
    }
    finishAttempt();
    terminalSse(response, state, id, 'completed', translator.outputText, { type: 'response.completed', response: { id, object: 'response', status: 'completed', model, output: translator.output } }, { id: attemptId, result: 'completed', preOutputFailure: false }, logDownstreamOutbound);
    response.end();
    return { outcome: 'completed' };
  } catch {
    finishAttempt();
    if (cancelState.cancelled) {
      return { outcome: 'terminal', attempt: { id: attemptId, result: 'cancelled', preOutputFailure: !translator.outputStarted, errorCode: 'client_disconnected' }, failedOutputText: translator.outputText, streamStarted };
    }
    if (translator.outputStarted) {
      return { outcome: 'terminal', attempt: { id: attemptId, result: 'failed', preOutputFailure: false, errorCode: 'upstream_stream_failed' }, failedOutputText: translator.outputText, streamStarted };
    }
    return { outcome: 'retryable', attempt: { id: attemptId, result: 'failed', preOutputFailure: true, errorCode: 'upstream_retryable' }, streamStarted };
  }
};

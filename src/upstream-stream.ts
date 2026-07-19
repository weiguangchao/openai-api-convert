import { redactHeaders } from './http.js';
import type { AppError, BridgeLogger } from './types.js';
import { StreamTranslator, type ToolContext } from './adapter.js';
import type { UpstreamJson, UpstreamJsonOutcome, UpstreamStream, UpstreamStreamEvent, UpstreamStreamOutcome, UpstreamStreamRequest } from './failover-execution.js';

export class FetchUpstreamStream implements UpstreamStream {
  #logging: BridgeLogger;
  #requestId: string;
  #toolContext: ToolContext;

  constructor(logging: BridgeLogger, requestId: string, toolContext: ToolContext) {
    this.#logging = logging;
    this.#requestId = requestId;
    this.#toolContext = toolContext;
  }

  async open(request: UpstreamStreamRequest, signal: AbortSignal): Promise<UpstreamStreamOutcome> {
    const upstreamUrl = new URL('/v1/chat/completions', request.upstream.baseUrl);
    const upstreamBody = { ...request.upstreamBody, ...(request.upstream.thinking ? { thinking: request.upstream.thinking } : {}) };
    const headers: Record<string, string> = {
      authorization: `Bearer ${request.upstream.apiKey}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
    };
    this.#logging.log('info', 'traffic_upstream_outbound', {
      requestId: this.#requestId, responseId: request.responseId, attempt_index: request.attemptIndex,
    });
    if (this.#logging.level === 'debug') {
      this.#logging.log('debug', 'traffic_upstream_outbound', {
        requestId: this.#requestId, responseId: request.responseId, attempt_index: request.attemptIndex,
        upstream_url: upstreamUrl.href, headers: redactHeaders(headers), body: JSON.stringify(upstreamBody),
      });
    }
    let response: Response;
    try {
      response = await fetch(upstreamUrl, {
        method: 'POST', headers,
        body: JSON.stringify(upstreamBody),
        signal,
      });
    } catch {
      this.#logging.log('info', 'traffic_upstream_inbound', {
        requestId: this.#requestId, responseId: request.responseId, attempt_index: request.attemptIndex, status: 0,
      });
      return { kind: 'unavailable' };
    }
    this.#logging.log('info', 'traffic_upstream_inbound', {
      requestId: this.#requestId, responseId: request.responseId, attempt_index: request.attemptIndex, status: response.status,
    });
    if (this.#logging.level === 'debug') {
      this.#logging.log('debug', 'traffic_upstream_inbound', {
        requestId: this.#requestId, responseId: request.responseId, attempt_index: request.attemptIndex,
        status: response.status, headers: redactHeaders(Object.fromEntries(response.headers.entries())),
      });
    }
    if (response.status === 408 || response.status === 429 || response.status >= 500 || !response.body) {
      await this.#logBody(request, response);
      return { kind: 'unavailable' };
    }
    if (response.status >= 400) {
      return { kind: 'rejected', status: response.status, error: await upstreamError(response) };
    }
    return { kind: 'stream', events: this.#events(request, response.body, this.#toolContext) };
  }

  async #logBody(request: UpstreamStreamRequest, response: Response) {
    if (this.#logging.level !== 'debug' || !response.body) return;
    this.#logging.log('debug', 'traffic_upstream_inbound', {
      requestId: this.#requestId, responseId: request.responseId, attempt_index: request.attemptIndex, body: await response.text(),
    });
  }

  async *#events(request: UpstreamStreamRequest, body: ReadableStream<Uint8Array>, toolContext: ToolContext): AsyncIterable<UpstreamStreamEvent> {
    const translator = new StreamTranslator(request.responseId, toolContext);
    for await (const frame of parseUpstream(body)) {
      if (this.#logging.level === 'debug') {
        this.#logging.log('debug', 'traffic_upstream_inbound', {
          requestId: this.#requestId, responseId: request.responseId, attempt_index: request.attemptIndex, body: frame.data,
        });
      }
      if (frame.event === 'error' || hasSubstantiveError(frame.data)) {
        yield { kind: 'failed', error: upstreamErrorFromPayload(frame.data, 502), outputText: translator.outputText, usage: translator.usage };
        return;
      }
      if (frame.data === '[DONE]') {
        const events = translator.finalize().filter((event) => event.type !== 'response.output_item.done');
        yield { kind: 'completed', status: translator.finishReason ?? 'completed', eventsBeforeOutputItems: events, output: translator.output, outputText: translator.outputText, usage: translator.usage };
        return;
      }
      yield { kind: 'heartbeat', usage: translator.usage };
      for (const event of translator.feed(frame.data)) {
        yield { kind: 'event', event, outputStarted: translator.outputStarted, outputText: translator.outputText, usage: translator.usage };
      }
    }
    if (translator.finishReason) {
      const events = translator.finalize().filter((event) => event.type !== 'response.output_item.done');
      yield { kind: 'completed', status: translator.finishReason, eventsBeforeOutputItems: events, output: translator.output, outputText: translator.outputText, usage: translator.usage };
    }
  }
}

export class FetchUpstreamJson implements UpstreamJson {
  #logging: BridgeLogger;
  #requestId: string;

  constructor(logging: BridgeLogger, requestId: string) {
    this.#logging = logging;
    this.#requestId = requestId;
  }

  async complete(request: UpstreamStreamRequest, signal: AbortSignal): Promise<UpstreamJsonOutcome> {
    const upstreamUrl = new URL('/v1/chat/completions', request.upstream.baseUrl);
    const upstreamBody = { ...request.upstreamBody, ...(request.upstream.thinking ? { thinking: request.upstream.thinking } : {}) };
    const headers = { authorization: `Bearer ${request.upstream.apiKey}`, 'content-type': 'application/json', accept: 'application/json' };
    this.#logging.log('info', 'traffic_upstream_outbound', { requestId: this.#requestId, responseId: request.responseId, attempt_index: request.attemptIndex });
    if (this.#logging.level === 'debug') this.#logging.log('debug', 'traffic_upstream_outbound', {
      requestId: this.#requestId, responseId: request.responseId, attempt_index: request.attemptIndex, upstream_url: upstreamUrl.href, headers: redactHeaders(headers), body: JSON.stringify(upstreamBody),
    });
    let response: Response;
    try {
      response = await fetch(upstreamUrl, { method: 'POST', headers, body: JSON.stringify(upstreamBody), signal });
    } catch {
      this.#logging.log('info', 'traffic_upstream_inbound', { requestId: this.#requestId, responseId: request.responseId, attempt_index: request.attemptIndex, status: 0 });
      return { kind: 'unavailable' };
    }
    this.#logging.log('info', 'traffic_upstream_inbound', { requestId: this.#requestId, responseId: request.responseId, attempt_index: request.attemptIndex, status: response.status });
    if (!response.ok) return response.status === 408 || response.status === 429 || response.status >= 500
      ? { kind: 'unavailable' } : { kind: 'rejected', status: response.status, error: await upstreamError(response) };
    try { return { kind: 'completion', completion: await response.json() }; }
    catch { return { kind: 'completion', completion: undefined }; }
  }
}

export type ParsedSseFrame = { event?: string; data: string };

export const parseUpstream = async function* (body: ReadableStream<Uint8Array>): AsyncIterable<ParsedSseFrame> {
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
      const lines = frame.split('\n');
      const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n');
      const event = lines.find((line) => line.startsWith('event:'))?.slice(6).trim();
      if (data) yield { ...(event ? { event } : {}), data };
    }
    if (done) break;
  }
};

const hasSubstantiveError = (data: string) => {
  try {
    const parsed = JSON.parse(data) as { error?: unknown };
    const error = parsed.error;
    if (typeof error === 'string') return error.length > 0;
    return !!error && typeof error === 'object' && Object.values(error as Record<string, unknown>).some((value) => value !== null && value !== undefined && value !== '');
  } catch {
    return false;
  }
};

const upstreamError = async (response: Response): Promise<AppError> => {
  try {
    return upstreamErrorFromPayload(await response.text(), response.status);
  } catch {
    return { status: response.status, message: 'Upstream rejected request', code: 'upstream_rejected' };
  }
};

const upstreamErrorFromPayload = (payload: string, status: number): AppError => {
  try {
    const parsed = JSON.parse(payload) as { error?: unknown };
    const raw = parsed.error;
    const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    return {
      status,
      message: typeof value.message === 'string' ? value.message : typeof raw === 'string' ? raw : 'Upstream rejected request',
      code: typeof value.code === 'string' ? value.code : 'upstream_rejected',
      ...(typeof value.type === 'string' ? { type: value.type } : {}),
      ...(typeof value.param === 'string' || value.param === null ? { param: value.param } : {}),
    };
  } catch {
    return { status, message: 'Upstream rejected request', code: 'upstream_rejected' };
  }
};

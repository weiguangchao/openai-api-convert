import { redactHeaders } from './http.js';
import type { BridgeLogger } from './types.js';
import { StreamTranslator, type NamespaceAliases } from './adapter.js';
import type { UpstreamStream, UpstreamStreamEvent, UpstreamStreamOutcome, UpstreamStreamRequest } from './failover-execution.js';

export class FetchUpstreamStream implements UpstreamStream {
  #logging: BridgeLogger;
  #requestId: string;
  #namespaceAliases: NamespaceAliases;

  constructor(logging: BridgeLogger, requestId: string, namespaceAliases: NamespaceAliases) {
    this.#logging = logging;
    this.#requestId = requestId;
    this.#namespaceAliases = namespaceAliases;
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
      await this.#logBody(request, response);
      return { kind: 'rejected' };
    }
    return { kind: 'stream', events: this.#events(request, response.body, this.#namespaceAliases) };
  }

  async #logBody(request: UpstreamStreamRequest, response: Response) {
    if (this.#logging.level !== 'debug' || !response.body) return;
    this.#logging.log('debug', 'traffic_upstream_inbound', {
      requestId: this.#requestId, responseId: request.responseId, attempt_index: request.attemptIndex, body: await response.text(),
    });
  }

  async *#events(request: UpstreamStreamRequest, body: ReadableStream<Uint8Array>, namespaceAliases: NamespaceAliases): AsyncIterable<UpstreamStreamEvent> {
    const translator = new StreamTranslator(request.responseId, namespaceAliases);
    for await (const data of parseUpstream(body)) {
      if (this.#logging.level === 'debug') {
        this.#logging.log('debug', 'traffic_upstream_inbound', {
          requestId: this.#requestId, responseId: request.responseId, attempt_index: request.attemptIndex, body: data,
        });
      }
      if (data === '[DONE]') {
        const events = translator.finalize().filter((event) => event.type !== 'response.output_item.done');
        yield { kind: 'completed', eventsBeforeOutputItems: events, output: translator.output, outputText: translator.outputText };
        return;
      }
      yield { kind: 'heartbeat' };
      for (const event of translator.feed(data)) {
        yield { kind: 'event', event, outputStarted: translator.outputStarted, outputText: translator.outputText };
      }
    }
  }
}

export const parseUpstream = async function* (body: ReadableStream<Uint8Array>) {
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

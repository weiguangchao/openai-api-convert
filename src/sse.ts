import type { ServerResponse } from 'node:http';
import type { AttemptCompletion, BridgeLogger, OutputItem, ResponseEvent } from './types.js';
import type { StateStore } from './state.js';
import type { StreamEventSink } from './failover-execution.js';

export class HttpStreamEventSink implements StreamEventSink {
  #response: ServerResponse;
  #store: StateStore;
  #responseId: string;
  #logging: BridgeLogger;
  #requestId: string;
  #started = false;

  constructor(response: ServerResponse, store: StateStore, responseId: string, logging: BridgeLogger, requestId: string) {
    this.#response = response;
    this.#store = store;
    this.#responseId = responseId;
    this.#logging = logging;
    this.#requestId = requestId;
  }

  startAttempt() {
    return this.#store.startAttempt(this.#responseId);
  }

  finishAttempt(attempt: AttemptCompletion) {
    this.#store.finishAttempt(attempt);
  }

  emit(event: ResponseEvent, attemptIndex: number) {
    this.#store.appendEvent(this.#responseId, event);
    this.#write(event, attemptIndex);
  }

  emitOutputItems(output: OutputItem[], attemptIndex: number) {
    for (const [outputIndex, item] of output.entries()) {
      this.#store.appendOutputItem(this.#responseId, outputIndex, item);
      this.emit({ type: 'response.output_item.done', output_index: outputIndex, item }, attemptIndex);
    }
  }

  terminal(status: 'completed' | 'failed' | 'cancelled', outputText: string, event: ResponseEvent, attempt: AttemptCompletion | undefined, attemptIndex: number) {
    this.#store.terminal(this.#responseId, status, outputText, event, attempt);
    this.#write(event, attemptIndex);
  }

  #write(event: ResponseEvent, attemptIndex: number) {
    if (!this.#response.destroyed && !this.#response.writableEnded) {
      if (!this.#started) {
        this.#response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        this.#started = true;
      }
      this.#response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }
    this.#logging.log('info', 'traffic_downstream_outbound', {
      requestId: this.#requestId, responseId: this.#responseId, attempt_index: attemptIndex, event_type: event.type,
    });
    if (this.#logging.level === 'debug') {
      this.#logging.log('debug', 'traffic_downstream_outbound', {
        requestId: this.#requestId, responseId: this.#responseId, attempt_index: attemptIndex, event_type: event.type, sse_event: event,
      });
    }
  }
}

export const writeSse = (response: ServerResponse, event: ResponseEvent) => {
  response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
};

export const replaySse = async (response: ServerResponse, store: StateStore, responseId: string) => {
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

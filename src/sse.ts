import type { ServerResponse } from 'node:http';
import type { AttemptCompletion, ResponseEvent } from './types.ts';
import type { StateStore } from './state.ts';
import { sendError } from './server.ts';

export const sse = (response: ServerResponse, store: StateStore, responseId: string, event: ResponseEvent, logDownstream?: (event: ResponseEvent) => void) => {
  store.appendEvent(responseId, event);
  response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  logDownstream?.(event);
};

export const terminalSse = (response: ServerResponse, store: StateStore, responseId: string, status: 'completed' | 'failed', outputText: string, event: ResponseEvent, attempt?: AttemptCompletion, logDownstream?: (event: ResponseEvent) => void) => {
  store.terminal(responseId, status, outputText, event, attempt);
  response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  logDownstream?.(event);
};

export const finishUpstreamFailure = (response: ServerResponse, store: StateStore, id: string, status: number, message: string, code: string) => {
  store.discardRejectedResponse(id);
  sendError(response, status, message, code);
};

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

import assert from 'node:assert/strict';
import test from 'node:test';
import { parseUpstream } from '../src/upstream-stream.js';

const stream = (text: string) => new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(new TextEncoder().encode(text));
    controller.close();
  },
});

test('parseUpstream accepts LF and CRLF frames and joins multiline data', async () => {
  const frames = [];
  for await (const frame of parseUpstream(stream(
    'event: message\ndata: {"choices":[\ndata: {"delta":{"content":"Hello"}}]}\n\n'
      + 'data: [DONE]\r\n\r\n'
      + 'event: error\r\ndata: {"error":{"message":"bad"}}\r\n\r\n',
  ))) frames.push(frame);
  assert.deepEqual(frames, [
    { event: 'message', data: '{"choices":[\n{"delta":{"content":"Hello"}}]}' },
    { data: '[DONE]' },
    { event: 'error', data: '{"error":{"message":"bad"}}' },
  ]);
});

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppError } from './types.js';

export const requestIds = new WeakMap<ServerResponse, string>();
const errorCodes = new WeakMap<ServerResponse, string>();

export const sendError = (response: ServerResponse, status: number, message: string, code: string, details?: { type?: string; param?: string | null }) => {
  errorCodes.set(response, code);
  response.writeHead(status, { 'content-type': 'application/json', 'x-request-id': requestIds.get(response) ?? randomUUID() });
  response.end(JSON.stringify({ error: { message, type: details?.type ?? 'invalid_request_error', param: details?.param ?? null, code } }));
};

export const setErrorCode = (response: ServerResponse, code: string) => {
  errorCodes.set(response, code);
};

export const getErrorCode = (response: ServerResponse): string | undefined => errorCodes.get(response);

export const requireBridgeAuthentication = (request: IncomingMessage, response: ServerResponse, apiKey: string) => {
  if (request.headers.authorization === `Bearer ${apiKey}`) return true;
  sendError(response, 401, 'Invalid authentication credentials', 'invalid_api_key');
  return false;
};

const REDACTED = '[REDACTED]';
const sensitiveHeaderNames = new Set(['authorization', 'cookie', 'set-cookie']);
export const redactHeaders = (headers: Record<string, string | string[] | undefined>): Record<string, string> => {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    redacted[key] = sensitiveHeaderNames.has(key.toLowerCase()) ? REDACTED : String(value ?? '');
  }
  return redacted;
};

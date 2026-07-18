import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { BridgeOptions, RequestContext, ResponseScope, RunningBridge, Upstream } from './types.js';
import { createBridgeLogger } from './logging.js';
import { StateStore, defaultStatePolicy } from './state.js';
import { sendError, requireBridgeAuthentication, requestIds, setErrorCode, getErrorCode } from './http.js';
import { handleResponsesRequest } from './responses.js';

export type { CapabilityProfile, Upstream, StatePolicy, LogLevel, LoggingPolicy, BridgeOptions, RunningBridge } from './types.js';

const upstreamReady = async (upstream: Upstream) => {
  try {
    const response = await fetch(new URL('/v1/models', upstream.baseUrl), {
      headers: { authorization: `Bearer ${upstream.apiKey}` },
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok;
  } catch {
    return false;
  }
};

const assertOptions = (options: BridgeOptions) => {
  if (!options.apiKey.trim()) throw new Error('Bridge API key is required');
  if (!options.upstreams.length) throw new Error('Upstream Pool is required');
  for (const upstream of options.upstreams) {
    try { new URL(upstream.baseUrl); } catch { throw new Error('Upstream Pool contains an invalid URL'); }
    if (!upstream.apiKey.trim()) throw new Error('Upstream Pool contains an empty API key');
    if (upstream.capabilities && Object.values(upstream.capabilities).some((value) => typeof value !== 'boolean')) {
      throw new Error('Upstream Pool contains an invalid capability profile');
    }
  }
  if (options.firstEventTimeoutMs !== undefined && (!Number.isInteger(options.firstEventTimeoutMs) || options.firstEventTimeoutMs <= 0)) {
    throw new Error('First event timeout must be a positive integer');
  }
  if (options.outputIdleTimeoutMs !== undefined && (!Number.isInteger(options.outputIdleTimeoutMs) || options.outputIdleTimeoutMs <= 0)) {
    throw new Error('Output idle timeout must be a positive integer');
  }
  for (const value of Object.values(options.statePolicy ?? {})) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('State Store policy values must be positive integers');
  }
  const policy = { ...defaultStatePolicy, ...options.statePolicy };
  if (policy.cleanupThresholdBytes >= policy.hardLimitBytes) throw new Error('State Store cleanup threshold must be below the hard limit');
};

const handleRequest = async (ctx: RequestContext, request: IncomingMessage, response: ServerResponse) => {
  const { options, state, logging } = ctx;
  const requestId = randomUUID();
  const startedAt = Date.now();
  const scope: ResponseScope = { responseId: undefined };
  requestIds.set(response, requestId);
  response.setHeader('x-request-id', requestId);
  let observed = false;
  const observeRequest = (disconnected = false) => {
    if (observed) return;
    observed = true;
    if (disconnected && getErrorCode(response) === undefined) setErrorCode(response, 'client_disconnected');
    const durationMs = Date.now() - startedAt;
    const errorCode = getErrorCode(response) ?? null;
    logging.log(response.statusCode >= 400 || errorCode ? 'error' : 'info', 'http_request_completed', {
      requestId, responseId: scope.responseId ?? null, durationMs, errorCode, method: request.method ?? null, status: response.statusCode,
    });
  };
  response.once('finish', observeRequest);
  response.once('close', () => queueMicrotask(() => observeRequest(!response.writableEnded)));
  request.once('aborted', () => queueMicrotask(() => observeRequest(true)));
  if (request.method === 'GET' && request.url === '/healthz') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  if (request.method === 'GET' && request.url === '/readyz') {
    if (!requireBridgeAuthentication(request, response, options.apiKey)) return;
    const upstreamAvailable = await Promise.any(options.upstreams.map(async (upstream) => {
      if (await upstreamReady(upstream)) return true;
      throw new Error('upstream unavailable');
    })).catch(() => false);
    const ready = state.isReady() && upstreamAvailable;
    response.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: ready ? 'ready' : 'not_ready' }));
    return;
  }
  if (request.method !== 'POST' || request.url !== '/v1/responses') {
    sendError(response, 404, 'Not found', 'not_found');
    return;
  }
  await handleResponsesRequest(ctx, request, response, requestId, scope);
};

export const startBridge = async (options: BridgeOptions): Promise<RunningBridge> => {
  assertOptions(options);
  const logging = await createBridgeLogger(options.statePath, options.logging);
  const state = new StateStore(options.statePath, { ...defaultStatePolicy, ...options.statePolicy }, logging.log);
  const ctx: RequestContext = { options, state, logging };
  let server: Server | undefined;
  try {
    server = createServer((request, response) => handleRequest(ctx, request, response));
    await new Promise<void>((resolve, reject) => server!.once('error', reject).listen(options.port ?? 0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Bridge did not bind a TCP port');
    logging.log('info', 'bridge_started', { address: address.address, port: address.port });
    return {
      url: `http://127.0.0.1:${address.port}`,
      state,
      log: logging.log,
      close: async () => {
        await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
        state.close();
        await logging.close();
      },
    };
  } catch (error) {
    server?.close();
    state.close();
    await logging.close().catch(() => undefined);
    throw error;
  }
};

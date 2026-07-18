import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type {
  AttemptCompletion,
  BridgeOptions,
  ChatMessage,
  Metrics,
  OutputItem,
  ResponseEvent,
  RunningBridge,
  StateObservability,
  StoredResponse,
  Tool,
  Upstream,
} from './types.ts';
import { createBridgeLogger } from './logging.ts';
import { StateStore, defaultStatePolicy, digest } from './state.ts';
import {
  buildNamespaceAliasMaps,
  normalizeInput,
  normalizeTools,
  parseReasoningEffort,
  toChatMessages,
  toChatToolChoice,
  toChatTools,
  WEB_SEARCH_UNAVAILABLE_HINT,
} from './adapter.ts';
import {
  finishUpstreamFailure,
  parseUpstream,
  replaySse,
  sse,
  terminalSse,
} from './sse.ts';

export type { CapabilityProfile, Upstream, StatePolicy, LogLevel, LoggingPolicy, BridgeOptions, RunningBridge } from './types.ts';

const requestIds = new WeakMap<ServerResponse, string>();
const errorCodes = new WeakMap<ServerResponse, string>();

const prometheus = (metrics: Metrics, observability: StateObservability) => [
  '# TYPE bridge_requests_total counter', `bridge_requests_total ${metrics.requests}`,
  '# TYPE bridge_request_failures_total counter', `bridge_request_failures_total ${metrics.failures}`,
  '# TYPE bridge_request_duration_seconds_sum counter', `bridge_request_duration_seconds_sum ${metrics.durationMs / 1_000}`,
  '# TYPE bridge_request_duration_seconds_count counter', `bridge_request_duration_seconds_count ${metrics.requests}`,
  '# TYPE bridge_upstream_switches_total counter', `bridge_upstream_switches_total ${metrics.upstreamSwitches}`,
  '# TYPE bridge_state_store_bytes gauge', `bridge_state_store_bytes ${observability.bytes}`,
  '# TYPE bridge_state_store_cleanup_runs_total counter', `bridge_state_store_cleanup_runs_total ${observability.cleanupRuns}`,
  '# TYPE bridge_state_store_deleted_chains_total counter', `bridge_state_store_deleted_chains_total ${observability.deletedChains}`,
  '# TYPE bridge_state_store_reclaimed_bytes_total counter', `bridge_state_store_reclaimed_bytes_total ${observability.reclaimedBytes}`,
  '# TYPE bridge_state_store_capacity_rejections_total counter', `bridge_state_store_capacity_rejections_total ${observability.capacityRejections}`,
].join('\n') + '\n';

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

export const sendError = (response: ServerResponse, status: number, message: string, code: string) => {
  errorCodes.set(response, code);
  response.writeHead(status, { 'content-type': 'application/json', 'x-request-id': requestIds.get(response) ?? randomUUID() });
  response.end(JSON.stringify({ error: { message, type: 'invalid_request_error', param: null, code } }));
};

const requireBridgeAuthentication = (request: IncomingMessage, response: ServerResponse, apiKey: string) => {
  if (request.headers.authorization === `Bearer ${apiKey}`) return true;
  sendError(response, 401, 'Invalid authentication credentials', 'invalid_api_key');
  return false;
};

const REDACTED = '[REDACTED]';
const sensitiveHeaderNames = new Set(['authorization', 'cookie', 'set-cookie']);
const redactHeaders = (headers: Record<string, string | string[] | undefined>): Record<string, string> => {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    redacted[key] = sensitiveHeaderNames.has(key.toLowerCase()) ? REDACTED : String(value ?? '');
  }
  return redacted;
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

export const startBridge = async (options: BridgeOptions): Promise<RunningBridge> => {
  assertOptions(options);
  const logging = await createBridgeLogger(options.statePath, options.logging);
  const state = new StateStore(options.statePath, { ...defaultStatePolicy, ...options.statePolicy }, logging.log);
  const metrics: Metrics = { requests: 0, failures: 0, durationMs: 0, upstreamSwitches: 0 };
  let server: Server | undefined;
  try {
    server = createServer(async (request, response) => {
      const requestId = randomUUID();
      const startedAt = Date.now();
      let responseId: string | undefined;
      requestIds.set(response, requestId);
      response.setHeader('x-request-id', requestId);
      const measuresRequest = request.method === 'POST' && request.url === '/v1/responses';
      let observed = false;
      const observeRequest = (disconnected = false) => {
        if (observed) return;
        observed = true;
        if (disconnected && !errorCodes.has(response)) errorCodes.set(response, 'client_disconnected');
        const durationMs = Date.now() - startedAt;
        if (measuresRequest) {
          metrics.requests += 1;
          metrics.durationMs += durationMs;
        }
        const errorCode = errorCodes.get(response) ?? null;
        if (measuresRequest && (response.statusCode >= 400 || errorCode)) metrics.failures += 1;
        logging.log(response.statusCode >= 400 || errorCode ? 'error' : 'info', 'http_request_completed', {
          requestId, responseId: responseId ?? null, durationMs, errorCode, method: request.method ?? null, status: response.statusCode,
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
      if (request.method === 'GET' && request.url === '/metrics') {
        if (!requireBridgeAuthentication(request, response, options.apiKey)) return;
        response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
        response.end(prometheus(metrics, state.observability()));
        return;
      }
      if (request.method !== 'POST' || request.url !== '/v1/responses') {
        sendError(response, 404, 'Not found', 'not_found');
        return;
      }
      if (!requireBridgeAuthentication(request, response, options.apiKey)) return;
      const idempotencyKey = request.headers['idempotency-key'];
      if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || !idempotencyKey)) {
        sendError(response, 400, 'Idempotency-Key must be a non-empty string', 'invalid_idempotency_key');
        return;
      }

      let payload: {
        stream?: unknown; input?: unknown; model?: unknown; tools?: unknown; previous_response_id?: unknown; parallel_tool_calls?: unknown;
        tool_choice?: unknown; include?: unknown; reasoning?: unknown;
      };
      let rawBody = '';
      try {
        for await (const chunk of request) rawBody += chunk;
        payload = JSON.parse(rawBody) as typeof payload;
      }
      catch { sendError(response, 400, 'Invalid JSON body', 'invalid_json'); return; }
      logging.log('info', 'traffic_downstream_inbound', { requestId, method: request.method ?? null, path: request.url ?? null });
      if (logging.level === 'debug') {
        logging.log('debug', 'traffic_downstream_inbound', {
          requestId, method: request.method ?? null, path: request.url ?? null,
          headers: redactHeaders(request.headers), body: rawBody,
        });
      }
      if (payload.stream !== true) {
        sendError(response, 400, 'Only stream: true is supported', 'stream_required');
        return;
      }
      const reasoningEffort = parseReasoningEffort(payload.reasoning);
      if (reasoningEffort === null) {
        sendError(response, 400, 'Invalid reasoning', 'invalid_reasoning');
        return;
      }
      const input = normalizeInput(payload.input);
      if (!input) {
        sendError(response, 400, 'Only text and Tool output input are supported', 'unsupported_input');
        return;
      }
      const tools = normalizeTools(payload.tools);
      if (payload.tools !== undefined && !tools) {
        sendError(response, 400, 'Only Function, Custom, Tool Namespace, and web_search tools are supported', 'unsupported_tools');
        return;
      }
      if (payload.previous_response_id !== undefined && (typeof payload.previous_response_id !== 'string' || !payload.previous_response_id)) {
        sendError(response, 400, 'previous_response_id must be a string', 'invalid_previous_response_id');
        return;
      }
      if (input.some((item) => item.type === 'function_call_output') && !payload.previous_response_id) {
        sendError(response, 400, 'Tool output requires previous_response_id', 'missing_previous_response_id');
        return;
      }

      let ancestors: StoredResponse[] = [];
      if (payload.previous_response_id) {
        try { ancestors = state.chain(payload.previous_response_id); }
        catch { sendError(response, 400, 'Previous response was not found', 'previous_response_not_found'); return; }
      }
      const callKinds = new Map((ancestors.at(-1)?.output ?? [])
        .filter((item): item is Extract<OutputItem, { type: 'function_call' | 'custom_tool_call' }> => item.type === 'function_call' || item.type === 'custom_tool_call')
        .map((item) => [item.call_id, item.type]));
      if (input.some((item) => {
        const kind = callKinds.get(item.type === 'message' ? '' : item.call_id);
        return item.type !== 'message' && kind !== (item.type === 'function_call_output' ? 'function_call' : 'custom_tool_call');
      })) {
        sendError(response, 400, 'Tool call was not found', 'function_call_not_found');
        return;
      }
      const effectiveTools = tools ?? [...ancestors].reverse().find((item) => item.tools.length > 0)?.tools ?? [];
      const chainTools = [...ancestors.flatMap((item) => item.tools), ...effectiveTools];
      const needs = {
        functionTools: chainTools.some((tool) => tool.type === 'function' || tool.type === 'namespace'),
        customTools: chainTools.some((tool) => tool.type === 'custom'),
        parallelToolCalls: payload.parallel_tool_calls === true || ancestors.some((item) => item.parallelToolCalls),
      };
      const degradeWebSearch = chainTools.some((tool) => tool.type === 'web_search');
      const matchesCapabilities = (upstream: Upstream) => (
        (!needs.functionTools || upstream.capabilities?.functionTools === true)
        && (!needs.customTools || upstream.capabilities?.customTools === true)
        && (!needs.parallelToolCalls || upstream.capabilities?.parallelToolCalls === true)
      );
      const upstreams = options.upstreams.filter(matchesCapabilities);
      if (!upstreams.length) {
        sendError(response, 400, 'No upstream supports the requested capabilities', 'unsupported_capabilities');
        return;
      }
      let chatTools: ReturnType<typeof toChatTools>;
      let namespaceAliases: ReturnType<typeof buildNamespaceAliasMaps>;
      let chatToolChoice: ReturnType<typeof toChatToolChoice> | 'auto' | undefined;
      try {
        chatTools = toChatTools(effectiveTools);
        namespaceAliases = buildNamespaceAliasMaps(effectiveTools);
        const forcedWebSearchChoice = payload.tool_choice !== undefined && typeof payload.tool_choice === 'object' && payload.tool_choice !== null
          && (payload.tool_choice as { type?: unknown }).type === 'web_search';
        const mappedToolChoice = toChatToolChoice(payload.tool_choice, effectiveTools);
        if (mappedToolChoice === null) {
          sendError(response, 400, 'tool_choice targets an unknown Tool Namespace function', 'unsupported_tools');
          return;
        }
        chatToolChoice = degradeWebSearch && forcedWebSearchChoice ? 'auto' : mappedToolChoice;
      } catch {
        sendError(response, 400, 'Tool Namespace aliases conflict', 'unsupported_tools');
        return;
      }
      const messages: ChatMessage[] = [
        ...(degradeWebSearch ? [{ role: 'system' as const, content: WEB_SEARCH_UNAVAILABLE_HINT }] : []),
        ...ancestors.flatMap(toChatMessages),
        ...toChatMessages({ id: '', model: '', input, tools: [], parallelToolCalls: false, output: [] }),
      ];
      const model = typeof payload.model === 'string' ? payload.model : 'gpt-4.1';
      const upstreamBody: Record<string, unknown> = {
        model, stream: true, stream_options: { include_usage: true }, messages,
        ...(chatTools.length ? { tools: chatTools } : {}),
        ...(needs.parallelToolCalls ? { parallel_tool_calls: true } : {}),
        ...(chatToolChoice === undefined ? {} : { tool_choice: chatToolChoice }),
        ...(reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort }),
      };

      const id = `resp_${randomUUID().replaceAll('-', '')}`;
      const claim = state.claimResponse({
        id, parentId: payload.previous_response_id, model, input, tools: tools ?? [], parallelToolCalls: payload.parallel_tool_calls === true,
      }, idempotencyKey === undefined ? undefined : {
        subject: digest(request.headers.authorization),
        key: idempotencyKey,
        hash: digest({
          model, input, tools: payload.tools ?? [], previousResponseId: payload.previous_response_id ?? null,
          parallelToolCalls: payload.parallel_tool_calls === true, toolChoice: payload.tool_choice, include: payload.include,
          reasoningEffort: reasoningEffort ?? null,
        }),
      });
      if (claim.kind === 'conflict') {
        sendError(response, 409, 'Idempotency-Key is already used for a different request', 'idempotency_key_conflict');
        return;
      }
      if (claim.kind === 'capacity_exceeded') {
        sendError(response, 503, 'State Store capacity is exhausted', 'state_store_capacity_exceeded');
        return;
      }
      if (claim.kind === 'reused') {
        responseId = claim.responseId;
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        await replaySse(response, state, claim.responseId);
        return;
      }
      responseId = id;

      let streamStarted = false;
      let cancelled = false;
      let activeAbort: AbortController | undefined;
      let failedOutputText = '';
      const cancel = () => { errorCodes.set(response, 'client_disconnected'); cancelled = true; activeAbort?.abort(); };
      const onResponseClose = () => { if (!response.writableEnded) cancel(); };
      request.once('aborted', cancel);
      response.once('close', onResponseClose);
      try {
        let upstreamAttempts = 0;
        let terminalAttempt: AttemptCompletion | undefined;
        let retryAttempt: AttemptCompletion | undefined;
        const logDownstreamOutbound = (event: ResponseEvent) => {
          logging.log('info', 'traffic_downstream_outbound', { requestId, responseId: id, attempt_index: upstreamAttempts, event_type: event.type });
          if (logging.level === 'debug') {
            logging.log('debug', 'traffic_downstream_outbound', { requestId, responseId: id, attempt_index: upstreamAttempts, event_type: event.type, sse_event: event });
          }
        };
        for (const upstream of upstreams) {
          if (cancelled) break;
          if (retryAttempt) {
            state.finishAttempt(retryAttempt);
            retryAttempt = undefined;
          }
          const abort = new AbortController();
          activeAbort = abort;
          let timeout: ReturnType<typeof setTimeout> | undefined;
          const armTimeout = (milliseconds: number) => {
            if (timeout) clearTimeout(timeout);
            timeout = setTimeout(() => abort.abort(), milliseconds);
          };
          const finishAttempt = () => {
            if (timeout) clearTimeout(timeout);
            activeAbort = undefined;
          };
          armTimeout(options.firstEventTimeoutMs ?? 30_000);
          const attemptId = state.startAttempt(id);
          if (upstreamAttempts > 0) metrics.upstreamSwitches += 1;
          upstreamAttempts += 1;
          const upstreamUrl = new URL('/v1/chat/completions', upstream.baseUrl);
          const upstreamHeaders: Record<string, string> = { authorization: `Bearer ${upstream.apiKey}`, 'content-type': 'application/json', accept: 'text/event-stream' };
          logging.log('info', 'traffic_upstream_outbound', { requestId, responseId: id, attempt_index: upstreamAttempts });
          if (logging.level === 'debug') {
            logging.log('debug', 'traffic_upstream_outbound', {
              requestId, responseId: id, attempt_index: upstreamAttempts,
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
            logging.log('info', 'traffic_upstream_inbound', { requestId, responseId: id, attempt_index: upstreamAttempts, status: 0 });
            finishAttempt();
            if (cancelled) {
              terminalAttempt = { id: attemptId, result: 'cancelled', preOutputFailure: true, errorCode: 'client_disconnected' };
              break;
            }
            retryAttempt = { id: attemptId, result: 'failed', preOutputFailure: true, errorCode: 'upstream_retryable' };
            continue;
          }
          logging.log('info', 'traffic_upstream_inbound', { requestId, responseId: id, attempt_index: upstreamAttempts, status: upstreamResponse.status });
          if (logging.level === 'debug') {
            logging.log('debug', 'traffic_upstream_inbound', {
              requestId, responseId: id, attempt_index: upstreamAttempts, status: upstreamResponse.status,
              headers: redactHeaders(Object.fromEntries(upstreamResponse.headers.entries())),
            });
          }
          if (upstreamResponse.status === 408 || upstreamResponse.status === 429 || upstreamResponse.status >= 500 || !upstreamResponse.body) {
            if (logging.level === 'debug' && upstreamResponse.body) {
              logging.log('debug', 'traffic_upstream_inbound', { requestId, responseId: id, attempt_index: upstreamAttempts, body: await upstreamResponse.text() });
            }
            finishAttempt();
            retryAttempt = { id: attemptId, result: 'failed', preOutputFailure: true, errorCode: 'upstream_retryable' };
            continue;
          }
          if (upstreamResponse.status >= 400) {
            if (logging.level === 'debug') {
              logging.log('debug', 'traffic_upstream_inbound', { requestId, responseId: id, attempt_index: upstreamAttempts, body: await upstreamResponse.text() });
            }
            finishAttempt();
            if (!streamStarted) {
              finishUpstreamFailure(response, state, id, 400, 'Upstream rejected request', 'upstream_rejected');
              return;
            }
            terminalAttempt = { id: attemptId, result: 'failed', preOutputFailure: true, errorCode: 'upstream_rejected' };
            break;
          }
          if (!streamStarted) {
            response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
            sse(response, state, id, { type: 'response.created', response: { id, object: 'response', status: 'in_progress', model, output: [] } }, logDownstreamOutbound);
            streamStarted = true;
          }

          let outputStarted = false;
          let firstEvent = true;
          let outputText = '';
          let completed = false;
          let nextOutputIndex = 0;
          let textOutputIndex: number | undefined;
          const calls = new Map<number, { id?: string; name?: string; kind: 'function' | 'custom'; input: string; outputIndex: number }>();
          try {
            for await (const data of parseUpstream(upstreamResponse.body)) {
              if (logging.level === 'debug') {
                logging.log('debug', 'traffic_upstream_inbound', { requestId, responseId: id, attempt_index: upstreamAttempts, body: data });
              }
              if (firstEvent) {
                firstEvent = false;
                if (timeout) clearTimeout(timeout);
                timeout = undefined;
              }
              if (outputStarted) armTimeout(options.outputIdleTimeoutMs ?? 60_000);
              if (data === '[DONE]') { completed = true; break; }
              const chunk = JSON.parse(data) as { choices?: Array<{ delta?: { content?: unknown; tool_calls?: Array<{ index?: unknown; id?: unknown; type?: unknown; function?: { name?: unknown; arguments?: unknown }; custom?: { name?: unknown; input?: unknown } }> } }> };
              const delta = chunk.choices?.[0]?.delta;
              if (typeof delta?.content === 'string' && delta.content.length) {
                if (textOutputIndex === undefined) textOutputIndex = nextOutputIndex++;
                outputStarted = true;
                armTimeout(options.outputIdleTimeoutMs ?? 60_000);
                outputText += delta.content;
                sse(response, state, id, { type: 'response.output_text.delta', item_id: `msg_${id}`, output_index: textOutputIndex, content_index: 0, delta: delta.content }, logDownstreamOutbound);
              }
              for (const call of delta?.tool_calls ?? []) {
                if (!Number.isInteger(call.index) || Number(call.index) < 0) throw new Error('Invalid upstream Tool call');
                if (call.type !== undefined && call.type !== 'function' && call.type !== 'custom') throw new Error('Invalid upstream Tool call');
                const kind = call.type === 'custom' ? 'custom' : 'function';
                const current = calls.get(Number(call.index)) ?? {
                  kind, input: '', outputIndex: Number(call.index) + (textOutputIndex === undefined ? 0 : 1),
                };
                if (current.kind !== kind) throw new Error('Inconsistent upstream Tool call');
                nextOutputIndex = Math.max(nextOutputIndex, current.outputIndex + 1);
                if (typeof call.id === 'string') current.id = call.id;
                const name = current.kind === 'function' ? call.function?.name : call.custom?.name;
                const inputDelta = current.kind === 'function' ? call.function?.arguments : call.custom?.input;
                if (typeof name === 'string') current.name = name;
                if (typeof inputDelta === 'string') {
                  outputStarted = true;
                  armTimeout(options.outputIdleTimeoutMs ?? 60_000);
                  current.input += inputDelta;
                  sse(response, state, id, {
                    type: current.kind === 'function' ? 'response.function_call_arguments.delta' : 'response.custom_tool_call_input.delta',
                    item_id: current.id ?? `tc_${Number(call.index)}`, output_index: current.outputIndex, delta: inputDelta,
                  }, logDownstreamOutbound);
                }
                calls.set(Number(call.index), current);
              }
            }
            if (!completed) throw new Error('Upstream stream ended without [DONE]');
            const orderedOutput: Array<{ index: number; item: OutputItem }> = [];
            if (outputText && textOutputIndex !== undefined) orderedOutput.push({
              index: textOutputIndex,
              item: { id: `msg_${id}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: outputText }] },
            });
            for (const [index, call] of [...calls.entries()].sort(([left], [right]) => left - right)) {
              if (!call.id || !call.name) throw new Error('Incomplete upstream Tool call');
              const resolved = call.kind === 'function' ? namespaceAliases.aliasToRef.get(call.name) : undefined;
              orderedOutput.push({
                index: call.outputIndex,
                item: call.kind === 'function'
                  ? {
                    id: call.id, type: 'function_call', status: 'completed', call_id: call.id,
                    name: resolved?.name ?? call.name, arguments: call.input,
                    ...(resolved ? { namespace: resolved.namespace } : {}),
                  }
                  : { id: call.id, type: 'custom_tool_call', status: 'completed', call_id: call.id, name: call.name, input: call.input },
              });
              sse(response, state, id, call.kind === 'function'
                ? { type: 'response.function_call_arguments.done', item_id: call.id, output_index: call.outputIndex, arguments: call.input }
                : { type: 'response.custom_tool_call_input.done', item_id: call.id, output_index: call.outputIndex, input: call.input }, logDownstreamOutbound);
            }
            const output = orderedOutput.sort((left, right) => left.index - right.index).map(({ item }) => item);
            for (const [index, item] of output.entries()) {
              state.appendOutputItem(id, index, item);
              sse(response, state, id, { type: 'response.output_item.done', output_index: index, item }, logDownstreamOutbound);
            }
            finishAttempt();
            terminalSse(response, state, id, 'completed', outputText, { type: 'response.completed', response: { id, object: 'response', status: 'completed', model, output } }, { id: attemptId, result: 'completed', preOutputFailure: false }, logDownstreamOutbound);
            response.end();
            return;
          } catch {
            finishAttempt();
            if (cancelled) {
              failedOutputText = outputText;
              terminalAttempt = { id: attemptId, result: 'cancelled', preOutputFailure: !outputStarted, errorCode: 'client_disconnected' };
              break;
            }
            if (outputStarted) {
              failedOutputText = outputText;
              terminalAttempt = { id: attemptId, result: 'failed', preOutputFailure: false, errorCode: 'upstream_stream_failed' };
              break;
            }
            retryAttempt = { id: attemptId, result: 'failed', preOutputFailure: true, errorCode: 'upstream_retryable' };
          }
        }
        if (cancelled) {
          const cancelledAttempt = terminalAttempt ?? (retryAttempt && { ...retryAttempt, result: 'cancelled' as const, errorCode: 'client_disconnected' });
          state.terminal(id, 'cancelled', failedOutputText, { type: 'response.cancelled', response: { id, object: 'response', status: 'cancelled' } }, cancelledAttempt);
          if (!response.destroyed) response.end();
          return;
        }
        if (!streamStarted) {
          finishUpstreamFailure(response, state, id, 503, 'Upstream unavailable', 'upstream_unavailable');
          return;
        }
        errorCodes.set(response, 'upstream_stream_failed');
        terminalSse(response, state, id, 'failed', failedOutputText, { type: 'response.failed', response: { id, object: 'response', status: 'failed' } }, terminalAttempt ?? retryAttempt, logDownstreamOutbound);
        response.end();
      } finally {
        request.removeListener('aborted', cancel);
        response.removeListener('close', onResponseClose);
      }
    });
    await new Promise<void>((resolve, reject) => server!.once('error', reject).listen(options.port ?? 0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Bridge did not bind a TCP port');
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

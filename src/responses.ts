import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppError, InputItem, OutputItem, RequestContext, ResponseScope, Result, ResponsesPayload, StoredResponse, Tool } from './types.js';
import { digest } from './state.js';
import { buildChatRequest, normalizeInput, normalizeTools, parseReasoningEffort } from './adapter.js';
import { HttpStreamEventSink, replaySse } from './sse.js';
import { redactHeaders, requireBridgeAuthentication, sendError, setErrorCode } from './http.js';
import { executeFailover, executeJsonFailover, type ExecutionNeeds } from './failover-execution.js';
import { FetchUpstreamJson, FetchUpstreamStream } from './upstream-stream.js';

type ParsedRequest = { payload: ResponsesPayload; rawBody: string; idempotencyKey: string | undefined; reasoningEffort: string | undefined; input: InputItem[]; tools: Tool[] | undefined };
type ResolvedChain = { ancestors: StoredResponse[]; input: InputItem[]; effectiveTools: Tool[]; degradeWebSearch: boolean; needs: ExecutionNeeds };
type ClaimResult = { kind: 'reused'; responseId: string } | { kind: 'created'; responseId: string };
type ChatCompletionJson = { choices?: Array<{ message?: { content?: unknown } }> };

export const handleResponsesRequest = async (ctx: RequestContext, request: IncomingMessage, response: ServerResponse, requestId: string, scope: ResponseScope) => {
  if (!requireBridgeAuthentication(request, response, ctx.options.apiKey)) return;
  const fail = (error: AppError) => { sendError(response, error.status, error.message, error.code); };
  const parsed = await parseAndValidateRequest(ctx, request, requestId);
  if (!parsed.ok) { fail(parsed.error); return; }
  const resolved = resolveChainAndCapabilities(ctx, parsed.value.payload, parsed.value.input, parsed.value.tools);
  if (!resolved.ok) { fail(resolved.error); return; }
  const built = buildChatRequest(parsed.value.payload, resolved.value.effectiveTools, resolved.value.ancestors, resolved.value.input, resolved.value.degradeWebSearch, parsed.value.reasoningEffort);
  if (!built.ok) { fail(built.error); return; }
  const claimed = await claimOrCreateResponse(ctx, request, parsed.value.payload, resolved.value.input, parsed.value.tools, parsed.value.reasoningEffort, parsed.value.idempotencyKey, built.value.model);
  if (!claimed.ok) { fail(claimed.error); return; }
  scope.responseId = claimed.value.responseId;
  if (claimed.value.kind === 'reused') {
    if (parsed.value.payload.stream !== true) {
      const reused = ctx.state.jsonResponse(claimed.value.responseId);
      if (!reused) { sendError(response, 409, 'Idempotent Response is not complete', 'idempotency_in_progress'); return; }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(reused));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    await replaySse(response, ctx.state, claimed.value.responseId);
    return;
  }
  const cancelled = new AbortController();
  const cancel = () => {
    setErrorCode(response, 'client_disconnected');
    cancelled.abort();
  };
  const onResponseClose = () => { if (!response.writableEnded) cancel(); };
  request.once('aborted', cancel);
  response.once('close', onResponseClose);
  try {
    if (parsed.value.payload.stream !== true) {
      const completed = await completeJsonResponse(ctx, built.value.upstreamBody, claimed.value.responseId, resolved.value.needs, requestId, cancelled.signal);
      if (!completed.ok) {
        if (completed.error.code === 'client_disconnected') return;
        ctx.state.discardRejectedResponse(claimed.value.responseId);
        sendError(response, completed.error.status, completed.error.message, completed.error.code);
        return;
      }
      ctx.logging.log('info', 'traffic_downstream_outbound', {
        requestId, responseId: claimed.value.responseId, event_type: 'response.completed',
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(completed.value));
      return;
    }
    const outcome = await executeFailover({
      responseId: claimed.value.responseId, model: built.value.model, upstreamBody: built.value.upstreamBody,
      upstreams: ctx.options.upstreams, needs: resolved.value.needs,
      firstEventTimeoutMs: ctx.options.firstEventTimeoutMs ?? 30_000, outputIdleTimeoutMs: ctx.options.outputIdleTimeoutMs ?? 60_000,
    }, new FetchUpstreamStream(ctx.logging, requestId, built.value.namespaceAliases), new HttpStreamEventSink(response, ctx.state, claimed.value.responseId, ctx.logging, requestId), cancelled.signal);
    if (outcome.kind === 'pre_output_failure') {
      ctx.state.discardRejectedResponse(claimed.value.responseId);
      if (outcome.reason === 'rejected') sendError(response, 400, 'Upstream rejected request', 'upstream_rejected');
      else if (outcome.reason === 'unsupported_capabilities') sendError(response, 400, 'No upstream supports the requested capabilities', 'unsupported_capabilities');
      else sendError(response, 503, 'Upstream unavailable', 'upstream_unavailable');
      return;
    }
    if (outcome.kind === 'failed') setErrorCode(response, 'upstream_stream_failed');
    if (!response.destroyed && !response.writableEnded) response.end();
  } finally {
    request.removeListener('aborted', cancel);
    response.removeListener('close', onResponseClose);
  }
};

const parseAndValidateRequest = async (ctx: RequestContext, request: IncomingMessage, requestId: string): Promise<Result<ParsedRequest>> => {
  const { logging } = ctx;
  const idempotencyKey = request.headers['idempotency-key'];
  if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || !idempotencyKey)) {
    return { ok: false, error: { status: 400, message: 'Idempotency-Key must be a non-empty string', code: 'invalid_idempotency_key' } };
  }
  let payload: ResponsesPayload;
  let rawBody = '';
  try {
    for await (const chunk of request) rawBody += chunk;
    payload = JSON.parse(rawBody) as ResponsesPayload;
  } catch {
    return { ok: false, error: { status: 400, message: 'Invalid JSON body', code: 'invalid_json' } };
  }
  logging.log('info', 'traffic_downstream_inbound', { requestId, method: request.method ?? null, path: request.url ?? null });
  if (logging.level === 'debug') {
    logging.log('debug', 'traffic_downstream_inbound', {
      requestId, method: request.method ?? null, path: request.url ?? null,
      headers: redactHeaders(request.headers), body: rawBody,
    });
  }
  if (payload.stream !== undefined && payload.stream !== true && payload.stream !== false) {
    return { ok: false, error: { status: 400, message: 'stream must be a boolean', code: 'invalid_stream' } };
  }
  const reasoningEffort = parseReasoningEffort(payload.reasoning);
  if (reasoningEffort === null) {
    return { ok: false, error: { status: 400, message: 'Invalid reasoning', code: 'invalid_reasoning' } };
  }
  const input = normalizeInput(payload.input);
  if (!input) {
    return { ok: false, error: { status: 400, message: 'Input contains an unsupported content part', code: 'unsupported_input' } };
  }
  const tools = normalizeTools(payload.tools);
  if (payload.tools !== undefined && !tools) {
    return { ok: false, error: { status: 400, message: 'Only Function, Custom, Tool Namespace, and web_search tools are supported', code: 'unsupported_tools' } };
  }
  if (payload.previous_response_id !== undefined && (typeof payload.previous_response_id !== 'string' || !payload.previous_response_id)) {
    return { ok: false, error: { status: 400, message: 'previous_response_id must be a string', code: 'invalid_previous_response_id' } };
  }
  const inlineCallKinds = new Map(input.flatMap((item) => item.type === 'function_call' || item.type === 'custom_tool_call'
    ? [[item.call_id, item.type] as const] : []));
  if (input.some((item) => (item.type === 'function_call_output' && inlineCallKinds.get(item.call_id) !== 'function_call')
    || (item.type === 'custom_tool_call_output' && inlineCallKinds.get(item.call_id) !== 'custom_tool_call')) && !payload.previous_response_id) {
    return { ok: false, error: { status: 400, message: 'Tool output requires previous_response_id', code: 'missing_previous_response_id' } };
  }
  return { ok: true, value: { payload, rawBody, idempotencyKey, reasoningEffort, input, tools } };
};

const resolveChainAndCapabilities = (ctx: RequestContext, payload: ResponsesPayload, input: InputItem[], tools: Tool[] | undefined): Result<ResolvedChain> => {
  const { options, state } = ctx;
  let ancestors: StoredResponse[] = [];
  if (payload.previous_response_id) {
    try { ancestors = state.chain(payload.previous_response_id as string); }
    catch { return { ok: false, error: { status: 400, message: 'Previous response was not found', code: 'previous_response_not_found' } }; }
  }
  const echoedMessageIds = new Set(ancestors.flatMap((ancestor) => ancestor.output)
    .flatMap((item) => item.type === 'message' ? [item.id] : []));
  const lastEchoedMessage = input.reduce((last, item, index) => (
    item.type === 'message' && item.role === 'assistant' && item.id && echoedMessageIds.has(item.id) ? index : last
  ), -1);
  const effectiveInput = lastEchoedMessage === -1 ? input : input.slice(lastEchoedMessage + 1);
  const callKinds = new Map((ancestors.at(-1)?.output ?? [])
    .filter((item): item is Extract<OutputItem, { type: 'function_call' | 'custom_tool_call' }> => item.type === 'function_call' || item.type === 'custom_tool_call')
    .map((item) => [item.call_id, item.type]));
  for (const item of effectiveInput) {
    if (item.type === 'function_call' || item.type === 'custom_tool_call') callKinds.set(item.call_id, item.type);
  }
  if (effectiveInput.some((item) => (item.type === 'function_call_output' && callKinds.get(item.call_id) !== 'function_call')
    || (item.type === 'custom_tool_call_output' && callKinds.get(item.call_id) !== 'custom_tool_call'))) {
    return { ok: false, error: { status: 400, message: 'Tool call was not found', code: 'function_call_not_found' } };
  }
  const effectiveTools = tools ?? [...ancestors].reverse().find((item) => item.tools.length > 0)?.tools ?? [];
  const chainTools = [...ancestors.flatMap((item) => item.tools), ...effectiveTools];
  const needs: ExecutionNeeds = {
    functionTools: chainTools.some((tool) => tool.type === 'function' || tool.type === 'namespace'),
    customTools: chainTools.some((tool) => tool.type === 'custom'),
    parallelToolCalls: payload.parallel_tool_calls === true || ancestors.some((item) => item.parallelToolCalls),
  };
  const degradeWebSearch = chainTools.some((tool) => tool.type === 'web_search');
  return { ok: true, value: { ancestors, input: effectiveInput, effectiveTools, degradeWebSearch, needs } };
};

const claimOrCreateResponse = async (ctx: RequestContext, request: IncomingMessage, payload: ResponsesPayload, input: InputItem[], tools: Tool[] | undefined, reasoningEffort: string | undefined, idempotencyKey: string | undefined, model: string): Promise<Result<ClaimResult>> => {
  const { state } = ctx;
  const id = `resp_${randomUUID().replaceAll('-', '')}`;
  const claim = state.claimResponse({
    id, parentId: payload.previous_response_id as string | undefined, model, input, tools: tools ?? [], parallelToolCalls: payload.parallel_tool_calls === true,
  }, idempotencyKey === undefined ? undefined : {
    subject: digest(request.headers.authorization),
    key: idempotencyKey,
    hash: digest({
      model, input, tools: payload.tools ?? [], previousResponseId: payload.previous_response_id ?? null,
      parallelToolCalls: payload.parallel_tool_calls === true, toolChoice: payload.tool_choice, include: payload.include,
      reasoningEffort: reasoningEffort ?? null, deliveryMode: payload.stream === true ? 'stream' : 'json',
      instructions: payload.instructions ?? null,
      maxOutputTokens: payload.max_output_tokens ?? null, maxTokens: payload.max_tokens ?? null, maxCompletionTokens: payload.max_completion_tokens ?? null,
      controls: Object.fromEntries([
        'temperature', 'top_p', 'presence_penalty', 'frequency_penalty', 'logit_bias', 'logprobs', 'top_logprobs', 'seed', 'stop', 'response_format', 'n', 'user',
      ].map((key) => [key, payload[key as keyof ResponsesPayload] === undefined
        ? { present: false } : { present: true, value: payload[key as keyof ResponsesPayload] }])),
    }),
  });
  if (claim.kind === 'conflict') {
    return { ok: false, error: { status: 409, message: 'Idempotency-Key is already used for a different request', code: 'idempotency_key_conflict' } };
  }
  if (claim.kind === 'capacity_exceeded') {
    return { ok: false, error: { status: 503, message: 'State Store capacity is exhausted', code: 'state_store_capacity_exceeded' } };
  }
  if (claim.kind === 'reused') {
    return { ok: true, value: { kind: 'reused', responseId: claim.responseId } };
  }
  return { ok: true, value: { kind: 'created', responseId: id } };
};

const completeJsonResponse = async (
  ctx: RequestContext,
  upstreamBody: Record<string, unknown>,
  responseId: string,
  needs: ExecutionNeeds,
  requestId: string,
  cancelled: AbortSignal,
): Promise<Result<{ id: string; object: string; status: string; model: string; output: OutputItem[] }>> => {
  const outcome = await executeJsonFailover({
    responseId, model: String(upstreamBody.model), upstreamBody, upstreams: ctx.options.upstreams, needs,
    firstEventTimeoutMs: ctx.options.firstEventTimeoutMs ?? 30_000, outputIdleTimeoutMs: ctx.options.outputIdleTimeoutMs ?? 60_000,
  }, new FetchUpstreamJson(ctx.logging, requestId), {
    startAttempt: () => ctx.state.startAttempt(responseId),
    finishAttempt: (attempt) => ctx.state.finishAttempt(attempt),
  }, cancelled);
  if (outcome.kind === 'cancelled') {
    ctx.state.cancelJson(responseId);
    return { ok: false, error: { status: 499, message: 'Client disconnected', code: 'client_disconnected' } };
  }
  if (outcome.kind === 'pre_output_failure') {
    return { ok: false, error: outcome.reason === 'unsupported_capabilities'
      ? { status: 400, message: 'No upstream supports the requested capabilities', code: 'unsupported_capabilities' }
      : outcome.reason === 'rejected'
        ? { status: outcome.status ?? 400, message: 'Upstream rejected request', code: 'upstream_rejected' }
        : { status: 503, message: 'Upstream unavailable', code: 'upstream_unavailable' } };
  }
  const completion = outcome.completion as ChatCompletionJson | undefined;
  const text = completion?.choices?.[0]?.message?.content;
    if (typeof text !== 'string') {
      ctx.state.finishAttempt({ ...outcome.attempt, result: 'failed', preOutputFailure: true, errorCode: 'upstream_invalid_json' });
      return { ok: false, error: { status: 502, message: 'Upstream returned an unsupported JSON completion', code: 'upstream_invalid_json' } };
    }
    const output: OutputItem[] = [{
      id: `msg_${responseId}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text }],
    }];
    ctx.state.completeJson(responseId, text, output, outcome.attempt);
    const completed = ctx.state.jsonResponse(responseId);
    if (!completed) return { ok: false, error: { status: 500, message: 'Completed Response was not persisted', code: 'state_store_error' } };
    return { ok: true, value: completed };
};

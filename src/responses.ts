import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppError, InputItem, OutputItem, RequestContext, ResponseScope, Result, ResponsesPayload, StoredResponse, Tool } from './types.js';
import { digest } from './state.js';
import { buildChatRequest, normalizeInput, normalizeTools, parseReasoningEffort } from './adapter.js';
import { HttpStreamEventSink, replaySse } from './sse.js';
import { redactHeaders, requireBridgeAuthentication, sendError, setErrorCode } from './http.js';
import { executeFailover, type ExecutionNeeds } from './failover-execution.js';
import { FetchUpstreamStream } from './upstream-stream.js';

type ParsedRequest = { payload: ResponsesPayload; rawBody: string; idempotencyKey: string | undefined; reasoningEffort: string | undefined; input: InputItem[]; tools: Tool[] | undefined };
type ResolvedChain = { ancestors: StoredResponse[]; effectiveTools: Tool[]; degradeWebSearch: boolean; needs: ExecutionNeeds };
type ClaimResult = { kind: 'reused'; responseId: string } | { kind: 'created'; responseId: string };

export const handleResponsesRequest = async (ctx: RequestContext, request: IncomingMessage, response: ServerResponse, requestId: string, scope: ResponseScope) => {
  if (!requireBridgeAuthentication(request, response, ctx.options.apiKey)) return;
  const fail = (error: AppError) => { sendError(response, error.status, error.message, error.code); };
  const parsed = await parseAndValidateRequest(ctx, request, requestId);
  if (!parsed.ok) { fail(parsed.error); return; }
  const resolved = resolveChainAndCapabilities(ctx, parsed.value.payload, parsed.value.input, parsed.value.tools);
  if (!resolved.ok) { fail(resolved.error); return; }
  const built = buildChatRequest(parsed.value.payload, resolved.value.effectiveTools, resolved.value.ancestors, parsed.value.input, resolved.value.degradeWebSearch, parsed.value.reasoningEffort);
  if (!built.ok) { fail(built.error); return; }
  const claimed = await claimOrCreateResponse(ctx, request, parsed.value.payload, parsed.value.input, parsed.value.tools, parsed.value.reasoningEffort, parsed.value.idempotencyKey, built.value.model);
  if (!claimed.ok) { fail(claimed.error); return; }
  scope.responseId = claimed.value.responseId;
  if (claimed.value.kind === 'reused') {
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
  if (payload.stream !== true) {
    return { ok: false, error: { status: 400, message: 'Only stream: true is supported', code: 'stream_required' } };
  }
  const reasoningEffort = parseReasoningEffort(payload.reasoning);
  if (reasoningEffort === null) {
    return { ok: false, error: { status: 400, message: 'Invalid reasoning', code: 'invalid_reasoning' } };
  }
  const input = normalizeInput(payload.input);
  if (!input) {
    return { ok: false, error: { status: 400, message: 'Only text and Tool output input are supported', code: 'unsupported_input' } };
  }
  const tools = normalizeTools(payload.tools);
  if (payload.tools !== undefined && !tools) {
    return { ok: false, error: { status: 400, message: 'Only Function, Custom, Tool Namespace, and web_search tools are supported', code: 'unsupported_tools' } };
  }
  if (payload.previous_response_id !== undefined && (typeof payload.previous_response_id !== 'string' || !payload.previous_response_id)) {
    return { ok: false, error: { status: 400, message: 'previous_response_id must be a string', code: 'invalid_previous_response_id' } };
  }
  if (input.some((item) => item.type === 'function_call_output') && !payload.previous_response_id) {
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
  const callKinds = new Map((ancestors.at(-1)?.output ?? [])
    .filter((item): item is Extract<OutputItem, { type: 'function_call' | 'custom_tool_call' }> => item.type === 'function_call' || item.type === 'custom_tool_call')
    .map((item) => [item.call_id, item.type]));
  if (input.some((item) => {
    const kind = callKinds.get(item.type === 'message' ? '' : item.call_id);
    return item.type !== 'message' && kind !== (item.type === 'function_call_output' ? 'function_call' : 'custom_tool_call');
  })) {
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
  return { ok: true, value: { ancestors, effectiveTools, degradeWebSearch, needs } };
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
      reasoningEffort: reasoningEffort ?? null,
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

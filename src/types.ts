import type { StateStore } from './state.js';

export type CapabilityProfile = { functionTools?: boolean; customTools?: boolean; parallelToolCalls?: boolean };
export type UpstreamThinkingPolicy = { type: 'enabled' | 'disabled' };
export type Upstream = { baseUrl: string; apiKey: string; capabilities?: CapabilityProfile; thinking?: UpstreamThinkingPolicy };
export type StatePolicy = {
  responseRetentionDays?: number;
  attemptRetentionDays?: number;
  cleanupThresholdBytes?: number;
  hardLimitBytes?: number;
};
export type LogLevel = 'debug' | 'info' | 'error';
export type LoggingPolicy = {
  level?: LogLevel;
  path?: string;
  retentionDays?: number;
};
export type ReleasePreflightPolicy = { model: string };
export type BridgeOptions = {
  apiKey: string;
  upstreams: Upstream[];
  statePath: string;
  port?: number;
  firstEventTimeoutMs?: number;
  outputIdleTimeoutMs?: number;
  statePolicy?: StatePolicy;
  logging?: LoggingPolicy;
  releasePreflight?: ReleasePreflightPolicy;
};
export type LogFields = {
  requestId?: string | null;
  responseId?: string | null;
  durationMs?: number;
  errorCode?: string | null;
  [key: string]: string | number | null | undefined | Record<string, unknown>;
};
export type BridgeLog = (level: LogLevel, event: string, fields?: LogFields) => void;
export type StoredEvent = { sequence: number; type: string };
export type ResponseEvent = { type: string; [key: string]: unknown };
export type FunctionTool = { type: 'function'; name: string; description?: string; parameters?: unknown; strict?: boolean };
export type CustomTool = { type: 'custom'; name: string; description?: string; format?: unknown };
export type WebSearchTool = { type: 'web_search' };
export type NamespaceTool = { type: 'namespace'; name: string; description: string; tools: FunctionTool[] };
export type Tool = FunctionTool | CustomTool | WebSearchTool | NamespaceTool;
export type FunctionToolOutput = { type: 'function_call_output'; call_id: string; output: string };
export type CustomToolOutput = { type: 'custom_tool_call_output'; call_id: string; output: string };
export type InlineFunctionCall = { type: 'function_call'; call_id: string; name: string; arguments: string };
export type InlineCustomToolCall = { type: 'custom_tool_call'; call_id: string; name: string; input: string };
export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'refusal'; refusal: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } }
  | { type: 'file'; file: { file_id?: string; filename?: string; file_data?: string } }
  | { type: 'input_audio'; input_audio: { data: string; format: string } };
export type InputMessage = { type: 'message'; id?: string; role: 'user' | 'assistant' | 'system' | 'developer'; content: string | ChatContentPart[] };
export type InputItem = InputMessage | FunctionToolOutput | CustomToolOutput | InlineFunctionCall | InlineCustomToolCall;
export type OutputItem =
  | { id: string; type: 'message'; status: 'completed'; role: 'assistant'; content: Array<{ type: 'output_text'; text: string }> }
  | { id: string; type: 'function_call'; status: 'completed'; call_id: string; name: string; arguments: string; namespace?: string }
  | { id: string; type: 'custom_tool_call'; status: 'completed'; call_id: string; name: string; input: string }
  | { id: string; type: 'web_search_call'; status: string; [key: string]: unknown };
export type StoredResponse = {
  id: string; parentId?: string; model: string; input: InputItem[]; tools: Tool[]; parallelToolCalls: boolean; output: OutputItem[];
};
export type IdempotencyClaim =
  | { kind: 'created'; responseId: string }
  | { kind: 'reused'; responseId: string }
  | { kind: 'conflict' }
  | { kind: 'capacity_exceeded' };
export type AttemptResult = 'completed' | 'failed' | 'cancelled';
export type AttemptCompletion = { id: number; result: AttemptResult; preOutputFailure: boolean; errorCode?: string };
export type ChatToolCall =
  | { id: string; type: 'function'; function: { name: string; arguments: string } }
  | { id: string; type: 'custom'; custom: { name: string; input: string } };
export type ChatMessage =
  | { role: 'user' | 'system'; content: string | ChatContentPart[] }
  | { role: 'tool'; tool_call_id: string; content: string }
  | { role: 'assistant'; content?: string | ChatContentPart[]; tool_calls?: ChatToolCall[] };

export type ResolvedStatePolicy = Required<StatePolicy>;
export type AppError = { status: number; message: string; code: string };
export type Result<T> = { ok: true; value: T } | { ok: false; error: AppError };

export type BridgeLogger = { log: BridgeLog; level: LogLevel; close: () => Promise<void> };
export type RequestContext = { options: BridgeOptions; state: StateStore; logging: BridgeLogger };
export type ResponseScope = { responseId: string | undefined };
export type ResponsesPayload = {
  stream?: unknown; input?: unknown; model?: unknown; tools?: unknown; previous_response_id?: unknown; parallel_tool_calls?: unknown;
  tool_choice?: unknown; include?: unknown; reasoning?: unknown; instructions?: unknown; max_output_tokens?: unknown; max_tokens?: unknown; max_completion_tokens?: unknown;
  temperature?: unknown; top_p?: unknown; presence_penalty?: unknown; frequency_penalty?: unknown; logit_bias?: unknown; logprobs?: unknown; top_logprobs?: unknown;
  seed?: unknown; stop?: unknown; response_format?: unknown; n?: unknown; user?: unknown;
};

export type RunningBridge = {
  url: string;
  state: Pick<StateStore, 'events' | 'responses' | 'attempts' | 'attemptDetails'>;
  log: BridgeLog;
  close: () => Promise<void>;
};

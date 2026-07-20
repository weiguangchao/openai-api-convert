# CLIProxyAPI: Responses -> Chat Completions 协议转换研究

- 研究日期：2026-07-20
- 调查仓库：`router-for-me/CLIProxyAPI`（Go，多 Provider 代理）
- 仓库地址：<https://github.com/router-for-me/CLIProxyAPI>
- 调查 commit：`fde40c5a0a2f8f6808bcde498bc6079f32c355ef`（`git log -1` 于 2026-07-20 取得）

## 概览与方向

CLIProxyAPI 把"下游对客户端暴露的协议"与"上游对 Provider 说的协议"解耦。当上游 Provider
是 OpenAI 兼容的 Chat Completions 端点时，由 `OpenAICompatExecutor` 承担转换：

- `from = "openai-response"`（下游 Responses API）→ `to = "openai"`（上游 Chat Completions）。
- 请求方向：`TranslateRequest("openai-response", "openai", ...)`。
- 响应方向：`TranslateNonStream` / `TranslateStream` 以 `("openai", "openai-response", ...)` 反向转换。

关键文件：

- 路由/Handler：`CLIProxyAPI/internal/api/server.go`、`CLIProxyAPI/sdk/api/handlers/openai/openai_responses_handlers.go`
- 通用执行层：`CLIProxyAPI/sdk/api/handlers/handlers.go`、`CLIProxyAPI/internal/runtime/executor/openai_compat_executor.go`
- 转换器（核心）：`CLIProxyAPI/internal/translator/openai/openai/responses/openai_openai-responses_request.go`
  及同目录 `openai_openai-responses_response.go`、`openai_openai-responses_tools.go`
- 推理/降级：`CLIProxyAPI/internal/thinking/apply.go`、`CLIProxyAPI/internal/thinking/strip.go`、`CLIProxyAPI/internal/thinking/provider/openai/apply.go`

## 1. 路由与入口

`POST /v1/responses` 在 Gin 路由里注册到 `OpenAIResponsesAPIHandler.Responses`，同时
`/backend-api/codex/responses`（Codex CLI 直连别名）也指向同一 handler
（`CLIProxyAPI/internal/api/server.go:538`、`CLIProxyAPI/internal/api/server.go:556`）。
`/responses/compact` 与 `GET /responses`（WebSocket）分别走 `Compact` / `ResponsesWebsocket`
（`CLIProxyAPI/internal/api/server.go:539`、`CLIProxyAPI/internal/api/server.go:537`）。

`Responses` 仅读取原始 JSON 字节、按 `stream` 字段分流，不做结构化解析——所有结构处理都推迟到
转换器里基于 `gjson` 按字段读取（`CLIProxyAPI/sdk/api/handlers/openai/openai_responses_handlers.go:372`、
`CLIProxyAPI/sdk/api/handlers/openai/openai_responses_handlers.go:386`）。`HandlerType()` 返回常量
`OpenaiResponse = "openai-response"`（`CLIProxyAPI/sdk/api/handlers/openai/openai_responses_handlers.go:345`，
常量定义见 `CLIProxyAPI/internal/constant/constant.go:23`）。

Handler 通过 `ExecuteWithAuthManager` / `ExecuteStreamWithAuthManager` 进入通用执行层。其中
`entryProtocol = handlerType`，`SourceFormat` 由它构造
（`CLIProxyAPI/sdk/api/handlers/handlers.go:777`），`ResponseFormat` 默认回退为 `SourceFormat`
（`CLIProxyAPI/sdk/cliproxy/executor/types.go:118`）。模型路由器据此挑选上游 executor；当 auth 标记为
OpenAI 兼容 Provider 时注册的是 `OpenAICompatExecutor`
（`CLIProxyAPI/sdk/cliproxy/service.go:1065`）。

## 2. 请求转换（Responses -> Chat Completions）

转换器在 `init()` 中以 `(OpenaiResponse, OpenAI, ...)` 注册
（`CLIProxyAPI/internal/translator/openai/openai/responses/init.go:9`，由
`CLIProxyAPI/internal/translator/init.go:28` 空白导入触发）。请求变换函数为
`ConvertOpenAIResponsesRequestToOpenAIChatCompletions`
（`CLIProxyAPI/internal/translator/openai/openai/responses/openai_openai-responses_request.go:30`）。
它以 `gjson`/`sjson` 在 `{"model":"","messages":[],"stream":false}` 模板上逐字段重建。

### 2.1 input / instructions / messages

- `instructions` 转为单条 `{"role":"system","content":...}` 放在消息头
  （`openai_openai-responses_request.go:58`）。
- `input` 为字符串时，转成单条 `role=user` 消息（`openai_openai-responses_request.go:295`）。
- `input` 为数组时，按 item `type` 分发（`openai_openai-responses_request.go:65`）：
  - `message`（含 role 缺省推导）：`developer` 归并为 `user`；content 数组按 part 类型映射，`input_text`/`output_text` →
    `{"type":"text","text":...}`，`input_image` → `{"type":"image_url","image_url":{...}}`
    （`openai_openai-responses_request.go:147`、`openai_openai-responses_request.go:176`、
    `openai_openai-responses_request.go:189`）。assistant 消息会尝试回填 `reasoning_content`
    （`openai_openai-responses_request.go:196`）。
  - `reasoning`：将 `summary[]` 中 `summary_text` 拼成 `reasoning_content`，缓冲到下一条 assistant
    消息上（`openai_openai-responses_request.go:209`，`collectOpenAIResponsesReasoningContent`
    在 `openai_openai-responses_request.go:350`）；无内容时占位为 `"[reasoning unavailable]"`
    （`openai_openai-responses_request.go:362`）。
  - `function_call` / `custom_tool_call`：连续缓冲，最终合并成一条带 `tool_calls` 的 assistant 消息
    （`openai_openai-responses_request.go:216`、`openai_openai-responses_request.go:268`）。custom tool 的
    自由输入被包成 `{"input": string}` 形态的 function arguments（`openai_openai-responses_request.go:289`）。
  - `function_call_output` / `custom_tool_call_output`：转成 `role=tool` 消息，`call_id` → `tool_call_id`
    （`openai_openai-responses_request.go:247`、`openai_openai-responses_request.go:281`）。
- 为满足严格上游"assistant(tool_calls) → tool(tool_call_id) 必须相邻"的约束，转换器维护
  `awaitingToolOutputs` / `deferredMessages`，将中间消息延后到所有 tool 输出回填后再追加
  （`openai_openai-responses_request.go:113`、`openai_openai-responses_request.go:120`）。

### 2.2 previous_response_id / store / 状态

Responses→ChatCompletions 路径**不维护服务端状态**。请求转换器既不读取也不转发
`previous_response_id`、`store`、`prompt_cache_key`、`temperature`、`top_p` 等字段——它们在
`out` 上根本不被写入，因此对上游 Chat Completions 请求不可见（见 `openai_openai-responses_request.go`
完整函数体，仅处理 model/stream/max_tokens/parallel_tool_calls/instructions/input/tools/reasoning_effort/tool_choice）。

这些字段的唯一去向是响应回填时被"原样回显"（见 §4）。也就是说，CLIProxyAPI 的 Responses→ChatCompletions
桥依赖客户端在 `input` 数组里完整重放历史；`previous_response_id` 只是个被透传回客户端的字符串标签，
不存在按 id 取历史消息的存储。项目里的 `internal/store/` 是 auth/token 持久化（Postgres/git/object
三种后端，见 `CLIProxyAPI/AGENTS.md` 的 Storage backends），与 Response 历史无关。

> 对照：原生 Codex/xAI WebSocket 上游路径会消费 `previous_response_id`，并在 `codex_executor.go`
> 里显式 `sjson.DeleteBytes(body, "previous_response_id")` 后用 prompt-cache/reasoning-replay 缓存
> 重建历史（`CLIProxyAPI/internal/runtime/executor/codex_executor.go:1141`）。但这些不属于"上游 Chat
> Completions"路径，本研究范围内不展开。

### 2.3 model / reasoning / 生成参数

- `model`：Handler 读 `gjson.GetBytes(rawJSON,"model")`，传给 executor；executor 用
  `thinking.ParseSuffix` 去掉推理后缀得到 `baseModel`
  （`CLIProxyAPI/internal/runtime/executor/openai_compat_executor.go:87`），并最终把 `model` 写入转换后的
  Chat 请求（`openai_openai-responses_request.go:41`）。模型名不做映射，原样转发。
- `max_output_tokens` → `max_tokens`（`openai_openai-responses_request.go:49`）。**不会**按 o 系列改写为
  `max_completion_tokens`；流式额外注入 `stream_options.include_usage = true` 以拿到末尾 usage
  （`CLIProxyAPI/internal/runtime/executor/openai_compat_executor.go:329`）。
- `parallel_tool_calls`：原样转发（`openai_openai-responses_request.go:53`）。
- `temperature` / `top_p` / `top_logprobs` / `service_tier` 等：**请求转换器不转发**（未在 `out` 写入），
  这与下游 Responses 回显时却把 `temperature`/`top_p` 写回响应（§4）形成不对称——可视为该桥当前的一个
  已知简化。
- `reasoning.effort` → `reasoning_effort`（小写原值），写在上游 Chat 请求上
  （`openai_openai-responses_request.go:335`）。`reasoning.summary` 等子字段不作为生成参数转发
  （只在 `reasoning` input item 里被回放成 `reasoning_content`，见 §2.1）。
- `reasoning` 在非推理模型上的降级：转换器写入 `reasoning_effort` 后，executor 调用
  `thinking.ApplyThinking(translated, req.Model, from, to, e.Identifier())`
  （`CLIProxyAPI/internal/runtime/executor/openai_compat_executor.go:117`）。`ApplyThinking` 以
  `toFormat="openai"` 走 OpenAI 提取器读取 `reasoning_effort`
  （`CLIProxyAPI/internal/thinking/apply.go:164`、`CLIProxyAPI/internal/thinking/apply.go:665`）；若模型
  注册表里 `modelInfo.Thinking == nil`（不支持推理），则调用 `StripThinkingConfig(body, "openai")`
  删除 `reasoning_effort` 字段并放行
  （`CLIProxyAPI/internal/thinking/apply.go:189`、`CLIProxyAPI/internal/thinking/strip.go:46`）。对未在
  注册表中的"用户自定义模型"，走 `applyCompatibleOpenAI` 不做能力校验、直接保留 `reasoning_effort`
  （`CLIProxyAPI/internal/thinking/provider/openai/apply.go:84`）。

  > 这与我们仓库 ADR `0005-reasoning-effort-mapping.md`（"不按模型裁剪允许集、允许 `ultra`、未知枚举
  > 400"）思路不同：CLIProxyAPI 对**已知模型**会按 `modelInfo.Thinking` 裁剪并静默 strip；对**未知模型**
  > 则宽松透传。effort 取值集合没有显式校验，未知枚举会被原样塞给上游。

### 2.4 tools 与 tool_choice

工具转换在 `openai_openai-responses_tools.go`。`convertResponsesToolToOpenAIChatTools` 按 `type` 分发
（`CLIProxyAPI/internal/translator/openai/openai/responses/openai_openai-responses_tools.go:10`）：

- `""` / `"function"` → Chat `{"type":"function","function":{name,description,parameters}}`
  （`openai_openai-responses_tools.go:74`）。`parameters` 从 `parameters` / `parametersJsonSchema` /
  `input_schema` / `function.parameters` 多路径取值（`openai_openai-responses_tools.go:108`）。
- `"custom"`（Codex 自由格式）→ 同样是 function，但 schema 固定为
  `{type:object, properties:{input:{type:string}}, required:[input]}`，description 嵌入原工具说明
  （`openai_openai-responses_tools.go:32`）。
- `"namespace"` → 子工具按 `namespace__name` 限定名扁平化为多个 function
  （`openai_openai-responses_tools.go:48`、`openai_openai-responses_tools.go:236`）。
- **内置工具（`web_search` / `file_search` / `computer_use_preview` 等）未处理**：落入 `default` 分支返回
  `nil`（`openai_openai-responses_tools.go:26`），即被静默丢弃，没有 Hosted Web Search 式的降级替代。
  `tool_search` 也没有专门处理（与 cc-switch 桥不同）。

工具来源同时合并顶层 `tools` 与 Codex Desktop 的 `additional_tools` input item
（`openai_openai-responses_request.go:296`、`openai_openai-responses_request.go:323`）。
`tool_choice` 原样 `SetRawBytes` 转发（`openai_openai-responses_request.go:343`）。注意：当 tools 全部被
丢弃（只剩内置工具）时，转换器并不主动移除 `tool_choice` / `parallel_tool_calls`，这一职责不在桥内，
而是上游自行处理或由 `ApplyPayloadConfigWithRequest` 配置层兜底。

反向还原（响应里把 `function.name` 还原成 namespace/custom 语义）依赖 `responsesCustomToolNames`、
`splitResponsesQualifiedFunctionCallFromRequest` 等基于原始请求重建的映射表
（`openai_openai-responses_tools.go:154`、`openai_openai-responses_tools.go:250`），它不持久化"Tool Context"，
完全靠每个请求自带的 tools 定义现场推导。

## 3. 流式处理（Chat Completions SSE -> Responses SSE）

流式入口：`ExecuteStream` 用 `bufio.Scanner`（50MB 缓冲）逐行读上游 SSE，只处理 `data:` 行，把每行
`TranslateStream` 后送入 channel
（`CLIProxyAPI/internal/runtime/executor/openai_compat_executor.go:389`、
`CLIProxyAPI/internal/runtime/executor/openai_compat_executor.go:426`）。扫描结束后若未见 `[DONE]`，喂一个
合成的 `data: [DONE]` 触发终态事件
（`CLIProxyAPI/internal/runtime/executor/openai_compat_executor.go:446`）。

转换函数 `ConvertOpenAIChatCompletionsResponseToOpenAIResponses` 维护一个有状态结构
`oaiToResponsesState`（`openai_openai-responses_response.go:27`、
`openai_openai-responses_response.go:217`），按 chunk 增量合成 Responses 事件：

1. 首个 chunk 发 `response.created` + `response.in_progress`（`openai_openai-responses_response.go:395`、
   `openai_openai-responses_response.go:402`）。`response.id` 直接用上游 `chat.completion.chunk.id`。
2. `choices[].delta.content` → 先 `response.output_item.added`（type=message）、
   `response.content_part.added`，再逐段 `response.output_text.delta`
   （`openai_openai-responses_response.go:452`、`openai_openai-responses_response.go:460`、
   `openai_openai-responses_response.go:469`）。
3. `delta.reasoning_content`（兼容 `delta.reasoning`）→ `response.output_item.added`(type=reasoning) +
   `response.reasoning_summary_part.added` + `response.reasoning_summary_text.delta`
   （`openai_openai-responses_response.go:493`、`openai_openai-responses_response.go:506`）。
4. `delta.tool_calls` → 按工具 `index` 维护缓冲，先 `response.output_item.added`（custom_tool_call 或
   function_call，custom 由请求里 tools 定义判定），再 `response.function_call_arguments.delta`
   （`openai_openai-responses_response.go:326`、`openai_openai-responses_response.go:334`、
   `openai_openai-responses_response.go:355`）。
5. `finish_reason` 触发 item 级收尾：`response.output_text.done` / `response.content_part.done` /
   `response.output_item.done`，以及 function 的 `response.function_call_arguments.done` +
   `response.output_item.done`（custom 则发 `response.custom_tool_call_input.done`）
   （`openai_openai-responses_response.go:578`、`openai_openai-responses_response.go:597`、
   `openai_openai-responses_response.go:660`）。
6. `response.completed` **不在 finish_reason 时发**，而是延迟到收到 `[DONE]` 才发，以便晚到的
   usage-only chunk 仍能填进 `response.usage`
   （`openai_openai-responses_response.go:247`，注释见
   `openai_openai-responses_response.go:578`）。

usage 在流中聚合：从 `usage.prompt_tokens` / `prompt_tokens_details.cached_tokens` /
`completion_tokens`(或 `output_tokens`) / `output_tokens_details.reasoning_tokens` /
`total_tokens` 累积到 state
（`openai_openai-responses_response.go:267`~`openai_openai-responses_response.go:294`），
最终写入 `response.completed` 的 `response.usage`
（`openai_openai-responses_response.go:196`~`openai_openai-responses_response.go:205`）。

事件类型**没有集中枚举**，全部是 `emitRespEvent("<type>", payload)` 调用处的字符串字面量
（`emitRespEvent` 定义于 `openai_openai-responses_response.go:67`，SSE 帧由
`CLIProxyAPI/internal/translator/common/bytes.go:76` 的 `SSEEventData` 拼成 `event: <type>\ndata: <json>`）。
出现的类型包括：`response.created`、`response.in_progress`、`response.output_item.added`、
`response.content_part.added`、`response.output_text.delta`、`response.output_text.done`、
`response.content_part.done`、`response.output_item.done`、`response.reasoning_summary_part.added`、
`response.reasoning_summary_text.delta`、`response.reasoning_summary_text.done`、
`response.reasoning_summary_part.done`、`response.function_call_arguments.delta`、
`response.function_call_arguments.done`、`response.custom_tool_call_input.done`、`response.completed`。

Handler 侧用 `responsesSSEFramer` 做半包修复与 `response.completed` 载荷修补后写回客户端
（`CLIProxyAPI/sdk/api/handlers/openai/openai_responses_handlers.go:544` 及同文件
`responsesSSEFramer` 相关方法 `:55`~`:302`）。

## 4. 输出回填（非流式 Completion -> Responses）

`ConvertOpenAIChatCompletionsResponseToOpenAIResponsesNonStream`
（`openai_openai-responses_response.go:704`）把单个 Chat Completion 转成 `object:"response"`：

- `id`：优先用上游 `id`，缺失则合成 `resp_<unixnano>_<counter>`
  （`openai_openai-responses_response.go:711`、`openai_openai-responses_response.go:28`）。
- 回显请求字段：从 `requestRawJSON` 把 `instructions`、`max_output_tokens`、`model`、
  `previous_response_id`、`store`、`temperature`、`top_p`、`tool_choice`、`tools`、`reasoning` 等原样
  拷回响应顶层（`openai_openai-responses_response.go:730`~`openai_openai-responses_response.go:793`）。
  即 `previous_response_id` / `store` 在这里被"回声式"填回。
- `output` 数组按 output_index 排序，包含：
  - reasoning item：当 `choices.0.message.reasoning_content` 非空、或请求里带 `reasoning` 时生成
    `{type:reasoning, summary:[{type:summary_text, text}]}`（`openai_openai-responses_response.go:778`）。
  - message item：`choices[].message.content` → `{type:message, content:[{type:output_text, text}]}`
    （`openai_openai-responses_response.go:811`）。
  - tool calls：`message.tool_calls[]` 按是否属于 custom tool 分别生成 `custom_tool_call` 或
    `function_call` item；call_id 缺失时合成 `call_<id>_<idx>_<tc>`（`openai_openai-responses_response.go:821`、
    `openai_openai-responses_response.go:836`、`openai_openai-responses_response.go:847`）。
- usage 映射：`prompt_tokens` → `usage.input_tokens`、
  `prompt_tokens_details.cached_tokens` → `usage.input_tokens_details.cached_tokens`、
  `completion_tokens` → `usage.output_tokens`、
  `output_tokens_details.reasoning_tokens` → `usage.output_tokens_details.reasoning_tokens`、
  `total_tokens` → `usage.total_tokens`；结构异常时整体回退为原 usage 对象
  （`openai_openai-responses_response.go:857`~`openai_openai-responses_response.go:873`）。
- **状态字段**：非流式输出**不计算** `status: incomplete` / `incomplete_details`（模板写死
  `status:"completed"`，`openai_openai-responses_response.go:707`），也不解析 `finish_reason == length`
  做截断语义。这是与我们仓库（按 `finish_reason=length` 映射 `incomplete`）的明显差异。

流式 `response.completed` 由 `buildResponsesCompletedEvent` 构造，output 数组按
reasoning → message → function_call/custom_tool_call 顺序、各自按 output_index 排序后写入
`response.output`，并同样回显请求字段与 usage
（`openai_openai-responses_response.go:71`、`openai_openai-responses_response.go:141`~`openai_openai-responses_response.go:205`）。

## 5. 状态与历史

如 §2.2 所述，Responses→ChatCompletions 路径**无服务端 Response 历史存储**。`previous_response_id`
只是请求里一个字符串，被转换器丢弃（不进上游 Chat 请求）、再在响应里从原始请求回显
（`openai_openai-responses_response.go:750`）。续接所需的 assistant 工具调用、reasoning、消息历史，
全部由客户端在下一轮 `input` 数组里重放；转换器仅负责把这些重放项重新拼成合规的 Chat messages
（§2.1 的 `function_call` / `function_call_output` / `reasoning` 处理就是为此服务）。

仓库内确实存在缓存机制，但都不属于本桥：

- `internal/cache/` 与 `codex_executor.go` 里的 `applyCodexReasoningReplayCache` /
  `cacheHelper` 是面向**原生 Codex Responses 上游**的 prompt-cache + reasoning 回放
  （`CLIProxyAPI/internal/runtime/executor/codex_executor.go:314`、
  `CLIProxyAPI/internal/runtime/executor/codex_executor.go:1801`），且会 `DeleteBytes(body,"previous_response_id")`
  （`CLIProxyAPI/internal/runtime/executor/codex_executor.go:1141`）。
- `internal/store/` 是 token/auth 持久化（`CLIProxyAPI/AGENTS.md` 的 Storage backends 段），不存 Response。

换言之：本桥与 cc-switch 桥（用 `CodexChatHistoryStore` 内存缓存 512 个 response 还原 tool_calls）不同，
CLIProxyAPI 完全放弃服务端续接，把回放责任推给客户端。

## 6. 错误与降级

- 上游非 2xx：executor 把状态码与响应体包成 `statusErr{code, msg}`
  （`CLIProxyAPI/internal/runtime/executor/openai_compat_executor.go:183` 非流式、
  `CLIProxyAPI/internal/runtime/executor/openai_compat_executor.go:382` 流式）。该 `statusErr` 实现
  `StatusCode()` / `RetryAfter()`（`openai_compat_executor.go:797`），由上层 failover/重试策略消费。
- 非流式错误：Handler 走 `WriteErrorResponse` 把上游错误体作为 JSON 返回，保留状态码
  （`CLIProxyAPI/sdk/api/handlers/openai/openai_responses_handlers.go:456`）。**未**规整为 Responses
  `{"error":{message,type,code,param}}` 信封——这是与我们仓库"Responses Error Envelope"（CONTEXT.md）
  的差异。
- 流式错误：一旦流已开始，`forwardResponsesStream` 用 `BuildOpenAIResponsesStreamErrorChunk` 生成
  `{"type":"error","code","message","sequence_number"}` 并以 `event: error` 发出
  （`CLIProxyAPI/sdk/api/handlers/openai/openai_responses_handlers.go:565`，构造器见
  `CLIProxyAPI/sdk/api/handlers/openai_responses_stream_error.go:46`，code 映射见
  `CLIProxyAPI/sdk/api/handlers/openai_responses_stream_error.go:17`）。注意它发的是 `type:"error"` 而非
  规范的 `response.failed` 事件。
- 流中收到非 `data:` 的裸 JSON/数组：当作 `502 Bad Gateway` 错误 chunk 终止
  （`CLIProxyAPI/internal/runtime/executor/openai_compat_executor.go:413`）。
- 不支持字段降级：见 §2.3——`reasoning` 在非推理模型上被 `StripThinkingConfig` 静默删除；内置工具
  被 `convertResponsesToolToOpenAIChatTools` 的 default 分支静默丢弃（§2.4）；`temperature`/`top_p` 等被
  请求转换器静默丢弃（§2.3）。没有 `400 invalid_request` 式的显式拒绝路径。

## 7. 整体架构

CLIProxyAPI 的协议转换是一个 `from × to` 翻译矩阵，目录结构为
`internal/translator/<上游provider>/<下游api>/<variant>/`。本研究关注的是
`internal/translator/openai/openai/responses/`（上游=openai chat-completions，下游=openai-responses）。
翻译器在 `init()` 里 `translator.Register(from, to, requestFn, responseFns)` 自注册
（`CLIProxyAPI/internal/translator/translator/translator.go:17`，SDK 侧注册表
`CLIProxyAPI/sdk/translator/registry.go:36`）。

调用链分层清晰，是典型的 adapter 模式：

1. **Handler 层**（`sdk/api/handlers/openai/`）：按下游协议暴露 `/v1/responses`、`/v1/chat/completions`
   等，只读 raw JSON、分流，不感知上游。
2. **通用执行层**（`sdk/api/handlers/handlers.go`）：`ExecuteWithAuthManager` 做 model 路由、auth 选择、
   interceptor 链，把 `SourceFormat`/`ResponseFormat` 装进 `Options`
   （`CLIProxyAPI/sdk/api/handlers/handlers.go:742`、`:777`）。
3. **Executor 层**（`internal/runtime/executor/`）：每个上游 provider 一个 executor。OpenAI 兼容上游统一
   用 `OpenAICompatExecutor`（`CLIProxyAPI/internal/runtime/executor/openai_compat_executor.go:85`），负责
   `TranslateRequest` → 发 HTTP → `TranslateNonStream`/`TranslateStream`。其它上游（Codex、Claude、Gemini、
   Antigravity、Kimi、xAI）各有独立 executor，但共用同一翻译矩阵与 `thinking` 管线。
4. **Translator 层**（`internal/translator/`）：纯协议变换，无 HTTP/状态。响应流式/非流式分别注册
   （`interfaces.TranslateResponse{Stream, NonStream}`）。
5. **Thinking 层**（`internal/thinking/`）：跨 provider 的"规范 ThinkingConfig → provider 适配"管线，
   `ApplyThinking` 是所有 executor 的公共后处理步骤（`CLIProxyAPI/AGENTS.md` 明确要求不得破坏此架构）。

上游 provider 选择由 auth 配置驱动：`bindExecutorFromAuth` 按 `a.Provider` 注册对应 executor，OpenAI 兼容
项统一落到 `OpenAICompatExecutor`（`CLIProxyAPI/sdk/cliproxy/service.go:1043`~`:1065`）。因此同一个下游
`/v1/responses` 端点，可以按模型路由到 chat-completions 上游、原生 Codex 上游、Claude 上游等不同 adapter，
正是多 upstream provider 的 adapter 抽象。

## 与 openai-api-convert 的对照

我们仓库（Node + TS Bridge）的 CONTEXT.md / ADR 0004 / 0005 描述的是一个"仅 Chat Completions 上游 +
持久化 Response Chain + 强契约"的桥。CLIProxyAPI 同方向桥（Responses→ChatCompletions）的做法对照如下：

- **上游范围**：我们 ADR 0004 明确"上游仅 Chat Completions"；CLIProxyAPI 是多 adapter，Chat Completions
  只是 `OpenAICompatExecutor` 一种，另有 Codex/Claude/Gemini 等并行 translator。
- **状态与续接**：我们以 `previous_response_id` 为 Response Chain 主键做**服务端持久化**（Response/
  Output Item/Attempt，见 CONTEXT.md 的 Response Chain、Stream Event Sink）；CLIProxyAPI 本桥**完全不存
  历史续接**，`previous_response_id` 仅回显，依赖客户端重放 `input`。这点差异最大。
- **Tool Context**：我们持久化"Tool Context"以保证续接不重新推导（CONTEXT.md）；CLIProxyAPI 每个请求现
  场从 tools 定义推导 namespace/custom 映射，无持久化。
- **Token Ceiling Mapping**：我们按 o 系列区分 `max_completion_tokens` / `max_tokens`（CONTEXT.md 的
  Token Ceiling Mapping）；CLIProxyAPI 统一只写 `max_tokens`。
- **Reasoning Effort**：我们 ADR 0005 不按模型裁剪、允许 `ultra`、未知枚举 400；CLIProxyAPI 对已知模型按
  `modelInfo.Thinking` 静默 strip，对未知模型宽松透传，无枚举校验。
- **字段透传**：我们只透传 CC Switch 允许集（Request Control Passthrough）；CLIProxyAPI 转换器只显式转发
  `max_tokens`/`parallel_tool_calls`/`tools`/`tool_choice`/`reasoning_effort`/`instructions`/`input`，
  `temperature`/`top_p` 被丢弃（请求侧），却在响应侧回显——存在不对称。
- **内置工具**：我们 Hosted Web Search 按降级处理（ADR 0002/0003）；CLIProxyAPI 的 `web_search`/
  `file_search` 落入 default 分支静默丢弃，无降级；`tool_search` 也未实现。
- **错误信封**：我们规整为 Responses `{"error":{message,type,code,param}}` 并保留状态码，流中用
  `response.failed`（CONTEXT.md 的 Responses Error Envelope）；CLIProxyAPI 非流式直接回吐上游错误体，流式
  发 `type:"error"`（非 `response.failed`）。
- **流式 usage**：我们都注入 `stream_options.include_usage` 以收末尾 usage；CLIProxyAPI 还把
  `response.completed` 延迟到 `[DONE]` 才发以容纳晚到 usage chunk，是个值得借鉴的实现细节。
- **实现栈**：CLIProxyAPI 用 Go + `gjson`/`sjson` 做无 schema 的字节级 JSON 改写，转换器是纯函数；我们
  是 Node + TS，倾向结构化类型与持久化状态机。两者风格差异源自 CLIProxyAPI"无状态多 provider 网关"与
  我们"有状态单上游 Bridge"的定位不同。

可借鉴点：流式状态机（`oaiToResponsesState`）的事件顺序与 output_index 分配、`response.completed` 延迟
到 `[DONE]` 的 usage 合并、namespace/custom tool 的 `__` 限定名双向映射，都与我们 CONTEXT.md 里的
Stream Translator / Output Item / Tool Namespace 概念对应，可作为实现参照。

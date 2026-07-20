# CC Switch：Codex Responses 与 Chat Completions 的桥接

调研对象：`farion1231/cc-switch` 的提交
[`997be22bfa5d14161a6f5b1f805631054368cdb0`](https://github.com/farion1231/cc-switch/tree/997be22bfa5d14161a6f5b1f805631054368cdb0)。

这里的方向是 **Codex Responses -> 上游 Chat Completions -> Codex Responses**，不是让
Chat 客户端直接改说 Responses。它在本地代理中保留 Codex 的 Responses wire API，只在选中的
上游供应商标记为 `openai_chat` 时转换。

## 触发与总链路

1. [`should_convert_codex_responses_to_chat`](https://github.com/farion1231/cc-switch/blob/997be22bfa5d14161a6f5b1f805631054368cdb0/src-tauri/src/proxy/providers/codex.rs#L76-L86)
   限定只有 Codex/GrokBuild 的 `/responses`、`/v1/responses` 及其 `/compact` 路由，且 provider
   真正使用 Chat Completions 时才触发。
2. [`forward_with_retry`](https://github.com/farion1231/cc-switch/blob/997be22bfa5d14161a6f5b1f805631054368cdb0/src-tauri/src/proxy/forwarder.rs#L1145-L1147)
   先完成模型映射；转换模式将目标端点重写为
   [`/chat/completions`](https://github.com/farion1231/cc-switch/blob/997be22bfa5d14161a6f5b1f805631054368cdb0/src-tauri/src/proxy/forwarder.rs#L2736-L2746)。
3. 转发前调用
   [`responses_to_chat_completions_with_reasoning`](https://github.com/farion1231/cc-switch/blob/997be22bfa5d14161a6f5b1f805631054368cdb0/src-tauri/src/proxy/providers/transform_codex_chat.rs#L260-L350)
   生成 Chat 请求；收到响应后，handler 根据普通 JSON 或 SSE 走不同的反向转换器。

## 请求映射

| Responses | Chat Completions |
| --- | --- |
| `instructions` | 开头的 `system` message；连续 system message 再折叠到消息头 |
| `input` | `messages`；`user`/`assistant`/`system` 保持角色，`developer` 归到 `system` |
| `max_output_tokens` | 普通模型为 `max_tokens`；o 系列为 `max_completion_tokens` |
| `temperature`、`top_p`、`stream` 和许可字段 | 同名转发 |
| `reasoning.effort` | 按 provider 元数据输出 `reasoning_effort`、`reasoning.effort` 或 thinking 开关 |
| Responses `function` | Chat `tools: [{ type: "function", function: ... }]` |
| Responses `custom` | 伪装成一个只有字符串 `input` 参数的 function；原定义写进描述 |
| `namespace` tool | 展平为单个 Chat function 名，再靠请求时生成的 context 反查 |
| `tool_search` | 伪装为 `tool_search` function |
| `function_call[_output]` | assistant `tool_calls` 与随后 `role: tool` message |

实现在 [`transform_codex_chat.rs`](https://github.com/farion1231/cc-switch/blob/997be22bfa5d14161a6f5b1f805631054368cdb0/src-tauri/src/proxy/providers/transform_codex_chat.rs)：
`CodexToolContext` 同时产出 Chat tool 定义和反向还原所需的名字/类型表；消息与工具输出的转换
见 `append_responses_input_as_chat_messages`。流式请求还注入 `stream_options.include_usage = true`，
以确保上游在末尾发送 usage。

## 跨轮工具调用

Responses 的下一轮常只有 `previous_response_id + function_call_output`，但 Chat 上游要求工具
输出前紧挨着原 assistant `tool_calls` message。故转发前，
[`CodexChatHistoryStore::enrich_request`](https://github.com/farion1231/cc-switch/blob/997be22bfa5d14161a6f5b1f805631054368cdb0/src-tauri/src/proxy/providers/codex_chat_history.rs#L63-L165)
从最多 512 个已返回 response 的内存缓存恢复原 call（优先 `previous_response_id`，必要时按唯一
`call_id` 回退），并补齐 reasoning。反向响应转换后立即记录这些 call，供下一轮使用。

## 非流式响应映射

[`chat_completion_to_response_with_context`](https://github.com/farion1231/cc-switch/blob/997be22bfa5d14161a6f5b1f805631054368cdb0/src-tauri/src/proxy/providers/transform_codex_chat.rs#L1271-L1330)
取第一条 Chat choice 并构造 `object: "response"`：

- Chat `id` 加 `resp_` 前缀；`finish_reason == length` 变 `status: incomplete` 和
  `incomplete_details.reason = max_output_tokens`；其他为 `completed`。
- `reasoning_content`/其他推理字段，或 content 开头 `<think>...</think>`，生成 `reasoning` output item；
  剩余文本生成 assistant `message/output_text`。
- `tool_calls`/旧 `function_call` 生成 completed 的 Responses function/custom/tool-search call；使用原
  `CodexToolContext` 还原 namespace 和 custom 语义。
- usage 将 `prompt_tokens`/`completion_tokens`、缓存 token 和 reasoning token 映射成 Responses usage。

## 流式响应与错误

[`streaming_codex_chat.rs`](https://github.com/farion1231/cc-switch/blob/997be22bfa5d14161a6f5b1f805631054368cdb0/src-tauri/src/proxy/providers/streaming_codex_chat.rs)
维护一个 `ChatToResponsesState`：解析任意分片的 Chat SSE，首先发 `response.created` /
`response.in_progress`，再把 reasoning、文本、工具参数增量分别编码为 Responses SSE 事件，并在
`[DONE]` 或 finish reason 后按原输出顺序发送 item done 与 `response.completed`。它也能把开头的
`<think>` 流式内容拆成 reasoning 和正文；缺失 finish reason 的中断流会生成 failed event，而不会
伪造 completed。

[`handle_codex_chat_to_responses_transform`](https://github.com/farion1231/cc-switch/blob/997be22bfa5d14161a6f5b1f805631054368cdb0/src-tauri/src/proxy/handlers.rs#L987-L1140)
选择流/非流转换、记录历史和用量。上游非 2xx 则通过
[`chat_error_to_response_error`](https://github.com/farion1231/cc-switch/blob/997be22bfa5d14161a6f5b1f805631054368cdb0/src-tauri/src/proxy/providers/transform_codex_chat.rs#L1730-L1807)
将标准及非标准错误体统一为 Codex 可识别的 `{"error":{"message","type","code","param"}}`，但保留原 HTTP 状态。

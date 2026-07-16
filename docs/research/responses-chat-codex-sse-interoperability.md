# Responses、Chat Completions 与 Codex SSE 互操作性

调研日期：2026-07-16。仅使用 OpenAI 官方文档和 `openai/codex` 源码。

## 结论

Response Bridge 应把 Chat Completions 流转换为 Responses 语义 SSE；不能透传 Chat 的 chunk 或 `[DONE]`。Codex 自定义 provider 的有效 wire API 是 `responses`，Chat Completions 支持已弃用。

## 协议事实

| 一端 | 流式契约 | 桥接含义 |
| --- | --- | --- |
| Responses | `POST /v1/responses`，请求 `stream: true`，HTTP SSE。每个事件是带 `type` 的预定义语义对象，如 `response.created`、`response.output_text.delta`、`response.output_item.done`、`response.completed`，还可能有拒绝、函数参数、推理和内置工具事件。 | 输出必须是合法 SSE，`data` 为带 `type` 的 Responses 事件 JSON；不能只实现文本。 |
| Chat Completions | `stream: true` 返回 data-only SSE；每块是 `chat.completion.chunk`，文本位于 `choices[].delta.content`。`stream_options.include_usage=true` 时，`data: [DONE]` 前还会有一个 `choices: []` 的 usage 块。 | 消费 chunk 与 `[DONE]`，累积文本、工具调用和用量，再产生对应 Responses 事件。 |
| Codex CLI | Codex 的 Responses 客户端向 `responses` 路径发起 `POST`，请求 `Accept: text/event-stream`。其 SSE 解析从每条 `data` JSON 的 `type` 分派；流关闭前若未收到 `response.completed`，视为错误。 | 至少发送 `response.created`、文本/输出项、带 `response.id` 的 `response.completed`；失败则发送可解析的 `response.failed` 或返回 HTTP 错误。 |

## 最小可验证路径

1. 接收 Codex 的 `POST /v1/responses`，保留 Responses 的 `input`、`tools`、会话/前序状态及 assistant `phase`；后者对 `gpt-5.3-codex` 及以后模型的后续请求不能丢失。
2. 转为 `POST /v1/chat/completions` 并设置 `stream: true`。
3. 将每个 `choices[].delta.content` 转为 `response.output_text.delta`；为完整 assistant 消息发 `response.output_item.done`。工具调用须保持 call id、顺序和参数，映射为相应 Responses 输出项/参数事件。
4. 在上游 `[DONE]` 后发送一次 `response.completed`（含稳定的 `response.id`；有用量则放入 `response.usage`），再关闭流。上游异常不能伪造成功完成。

## 范围边界

纯文本可形成 MVP，但不等于 Codex 互操作。Codex 会消费输出项、custom tool 输入、推理摘要/内容等事件；Responses 也可含拒绝和内置工具事件。因此 MVP 应明确拒绝或原样支持未实现的输入/输出能力，不能将其静默降为文本。

## 官方来源

- [Responses 流式指南](https://developers.openai.com/api/docs/guides/streaming-responses)：`stream=true` 使用 SSE；Responses 是带预定义 schema 的语义事件；列出文本、工具、推理与错误事件，并说明 Chat 是 data-only SSE。
- [Responses 创建接口](https://developers.openai.com/api/reference/resources/responses/methods/create)：`POST /responses`；输入项和 `assistant` 的 `phase` 语义。
- [Chat Completions 接口](https://developers.openai.com/api/reference/resources/chat)：`ChatCompletionChunk`、`choices[].delta`、工具调用，以及 usage 块在 `[DONE]` 前的规则。
- [Codex CLI 源码：Responses 请求](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/endpoint/responses.rs)：`POST responses` 与 `Accept: text/event-stream`。
- [Codex CLI 源码：Responses SSE 解析](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/sse/responses.rs)：按 JSON `type` 解析；`response.completed` 终止；未完成即断流报错。
- [Codex Manual](https://developers.openai.com/codex/codex-manual.md)：自定义 provider 示例的 `wire_api = "responses"` 为唯一支持值；Chat Completions 支持已弃用。

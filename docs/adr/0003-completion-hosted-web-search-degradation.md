# Completion 降级 Hosted Web Search

部分替代 [0002](0002-hosted-web-search-routing.md)：当无可用的原生 Responses Hosted Web Search 上游时，Chat Completions 上游可继续服务含 `web_search` 的请求，而非一律 `unsupported_capabilities`。

降级时：从 Completion 请求移除 `web_search`，保留 Function/Custom；注入系统提示声明搜索不可用并禁止声称已执行实时搜索；强制 `tool_choice: { type: "web_search" }` 降为 `auto`；不伪造 `web_search_call`、引用或搜索结果。已固定的 Native Web Search Chain 不降级。存在原生兼容上游时仍按 0002 路由。

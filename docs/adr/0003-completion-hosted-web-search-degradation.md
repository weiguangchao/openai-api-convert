# Completion 降级 Hosted Web Search

上游仅为 Chat Completions 时，含 `web_search` 的请求一律降级而非拒绝：从 Completion 请求移除 `web_search`，保留 Function/Custom；注入系统提示声明搜索不可用并禁止声称已执行实时搜索；强制 `tool_choice: { type: "web_search" }` 降为 `auto`；不伪造 `web_search_call`、引用或搜索结果。

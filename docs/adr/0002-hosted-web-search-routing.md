# 原生路由 Hosted Web Search

`web_search` 仅路由至显式支持 `wireApi: responses` 及 `capabilities.webSearch: true` 的上游。Chat 上游不得伪造搜索调用、引用或注释，以保留 Responses 的完整语义。首轮在输出前可切换兼容上游；首次成功后，含该工具的 Response Chain 固定同一上游，并保存 Bridge 与上游 Response ID 映射。跨上游重放会丢失原生搜索状态或重复搜索。Bridge 向客户端完整保留 `web_search_call`、消息注释及 URL 引用，不能降级为纯文本，并透明传递工具配置、`tool_choice` 与 `include`。对客户端的所有 SSE 事件保持 Bridge Response ID；上游 ID 仅用于续接。`web_search` 可与 Function/Custom Tool 混用，但单一原生上游必须满足全部能力；不得拆分或降级。首版严格拒绝 `web_search_preview`。

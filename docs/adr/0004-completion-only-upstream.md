# 上游仅 Chat Completions

废弃原生 Responses 上游与 `wireApi` / `webSearch` 配置。Upstream Pool 只有 Chat Completions；Hosted Web Search 一律按 [0003](0003-completion-hosted-web-search-degradation.md) 降级。State Store 不再保存上游 Response ID 映射。

Reasoning Effort：读下游 `reasoning.effort`，写入 Completion `reasoning_effort`；其它 `reasoning.*` 忽略；非法容器或枚举 `400`；幂等摘要含合法 effort。不按模型裁剪允许集。

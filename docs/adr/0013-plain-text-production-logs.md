# Production Log 使用单行文本格式

Traffic Log 的轮转文件与 stdout 均采用传统 Web 后端的单行、面向人的文本日志，而非 stdout JSON Lines。每行使用 UTC ISO 8601 时间戳、级别、`[bridge]` 组件、稳定事件名和 `key=value` 字段；安全标量裸写，其余值使用单行 JSON 字面量。该格式服务于本地排障与直接阅读；stdout 仍由 Service Supervisor 采集。

这是对 stdout 日志格式的 breaking change：不提供 JSON Lines 兼容开关或双写。此决定取代 ADR 0006 中关于 stdout JSON Lines 的部分，其余双 transport、日志级别、脱敏与独立保留策略保持不变；本次仅调整表现格式，不新增异常堆栈、正文或其他诊断数据。

# Traffic Log 与 State Cleanup Log 分轨

上下游排障需要完整交互明细，但 State Cleanup Log 只记录清理起止时间、删除链数、回收字节数与失败原因，不记录 Response 内容。因此引入独立的 Traffic Log：成熟日志框架双 transport（Configuration Home 的文件人类可读、stdout JSON Lines），默认开启、默认 `info`（仅元数据）、`debug` 才写完整 body/SSE；密钥始终脱敏；Log Retention 默认 7 天由框架执行，目录为 State Store 同级 `logs/`，不并入 Retention Policy / State Cleanup。stdout 供外部 Service Supervisor 采集。配置进 Bridge Configuration，与 ADR 0001 一致。两轨均不提供 metrics 导出。

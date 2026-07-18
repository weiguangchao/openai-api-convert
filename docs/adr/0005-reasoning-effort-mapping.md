# Reasoning Effort 映射

读下游 `reasoning.effort` 或兼容标量，写入 Completion `reasoning_effort`；`null` 表示未设置；其它对象字段忽略；未知类型或枚举 `400`；幂等摘要含合法 effort。不按模型裁剪允许集，允许 `ultra`。

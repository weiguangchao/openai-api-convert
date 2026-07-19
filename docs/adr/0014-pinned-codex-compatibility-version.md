# Codex 兼容版本

真实 Codex 预检使用本地已安装的 `codex-cli`，运行前只校验它能报告版本，不再固定某个兼容版本。Codex 工具声明是 Bridge 的客户端协议边界；预检仍要求语义 `response.completed`、无协议错误且不伪造 Hosted Web Search 调用，但不以特定 CLI 版本作为门禁。

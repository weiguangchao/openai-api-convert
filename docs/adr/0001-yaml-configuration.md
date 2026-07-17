# 单一 YAML 配置

Bridge 运行与 release smoke 共享根目录 `config.yaml`，配置必须严格校验；明文密钥仅保存在被忽略的配置文件，仓库提交 `config.example.yaml`。所有配置不再由 `process.env` 读取；为兼容 Codex，smoke 仅将 YAML 中的 Bridge 密钥注入其子进程环境。此举统一部署入口，代价是部署方必须安全管理本地明文配置文件。

# Configuration Home 首次初始化

生产安装后的 Bridge 以 `~/.openai-api-convert/` 作为默认 Configuration Home。首次 `start` 缺少配置时生成必填密钥留空的 YAML 模板并退出，下一次启动由严格校验拒绝空值；不以空密钥或环境变量启动。POSIX 上目录创建为 `0700`、配置为 `0600`，配置权限更宽即拒绝启动；Windows 不校验。`start --config <path>` 可显式替换配置位置。CLI 只提供 `start`，bootstrap 永不覆盖既有配置；配置只在启动时读取，变更经重启生效，且永不自动改写 YAML。这让全局 npm 安装脱离当前工作目录，同时避免未配置实例意外暴露服务。

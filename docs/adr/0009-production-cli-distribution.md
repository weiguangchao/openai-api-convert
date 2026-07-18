# Production CLI 分发

Bridge 首发为 `0.0.1` 的公开无 scope npm 包 `openai-api-convert`，采用 MIT 许可证，并提供全局安装后的 `openai-api-convert start` 入口。发布物只包含运行所需的 `dist/`、配置模板、README、LICENSE 与 package 元数据，不含源码、测试或构建工具；发布物必须是可由 Node.js `>=24` 直接执行的 JavaScript，而非仓库内依赖实验性 TypeScript 运行的源码入口。正式支持 Linux 与 macOS，Windows 仅尽力运行。该命令保持前台运行，daemon 与重启交由外部 Service Supervisor；README 提供 systemd 与 launchd 示例，但 npm 包不安装或管理其配置。

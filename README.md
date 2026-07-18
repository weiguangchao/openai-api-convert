# openai-api-convert

OpenAI Responses API 到 Chat Completions 的本地 Bridge。

要求：Node.js `>=24`；正式支持 Linux 与 macOS。

## 安装与启动

```sh
npm install -g openai-api-convert
openai-api-convert start
```

首次执行会创建 `~/.openai-api-convert/config.yaml` 后退出。填入 `apiKey`、上游 `baseUrl` 与上游 `apiKey` 后再次启动。

```sh
openai-api-convert start --config /srv/bridge/config.yaml
```

默认目录：

```text
~/.openai-api-convert/
├── config.yaml
├── response-bridge.db
└── logs/
```

默认端口为 `8417`，只监听 `127.0.0.1`。配置变更需重启；YAML 不会被自动改写。POSIX 上默认目录为 `0700`、配置文件为 `0600`，配置权限过宽会拒绝启动。

## 生产部署

使用反向代理对外转发 `/v1/responses`。`/healthz` 仅用于本机探针；`/readyz` 与 `/metrics` 要求 Bearer 鉴权。

`start` 保持前台运行。收到 `SIGTERM` 或 `SIGINT` 后最多等待 30 秒处理在途请求，再关闭状态库与日志。使用 systemd、launchd 或容器负责重启。

systemd 示例：

```ini
[Service]
ExecStart=/usr/local/bin/openai-api-convert start
Restart=on-failure
```

launchd 示例：

```xml
<key>ProgramArguments</key>
<array><string>/usr/local/bin/openai-api-convert</string><string>start</string></array>
<key>KeepAlive</key><true/>
```

将示例中的可执行路径替换为 `command -v openai-api-convert` 的结果。

日志同时写入 `logs/` 与 stdout JSON Lines。SQLite 状态库启动时仅自动前向迁移；升级前备份由部署方负责。

## 发布

首发版本为 `0.0.1`。本仓库只准备 tarball；公开发布由维护者审核后执行 `npm publish`。

# Context

## Glossary

- **MVP**: 可实施的首版设计，不含本次编码交付。
- **Response Bridge**: 将 OpenAI Responses API 请求转换并转发为 Chat Completions 请求的服务。
- **Response**: 一次已接受的规范请求及其不可变输入、输出项和终态。
- **Response Chain**: 由 `previous_response_id` 连接的 Response 链；MVP 的唯一会话模型。
- **Output Item**: Response 输出中的有序规范项，包含 assistant 内容或工具调用。
- **Custom Tool**: `type=custom` 的 Responses 工具；其自由格式输入与工具输出回传语义必须由上游原生保留。
- **Tool Namespace**: `type=namespace` 的 Responses 工具分组；MVP 仅接受 Function 子工具。Completion 上游以可逆、合法、最长 64 字符的可读哈希别名扁平转发；客户端始终看到原始 namespace 与子工具 name。
- **Hosted Web Search**: `type=web_search` 的 Responses 托管工具；由原生 Responses 上游执行并产出搜索调用、引用及注释。
- **Native Web Search Chain**: 含 Hosted Web Search 的 Response Chain；首轮成功后固定至创建该链的原生 Responses 上游。
- **Upstream Response Mapping**: Bridge Response ID 与原生上游 Response ID 的私有映射；客户端始终只使用前者。
- **Search Citation**: Hosted Web Search 消息文本上的 URL 注释；必须与其搜索调用一同向客户端保留。
- **Web Search Request Controls**: `web_search` 工具配置及关联的 `tool_choice`、`include`；Bridge 必须透明传递。
- **Parallel Tool Calling**: 同一 Response 中并行产生多个工具调用的语义；不得串行化替代。
- **Attempt**: 针对单个 Response 的一次上游调用记录；不参与会话重建。
- **Stream Event**: 向客户端发出的、带单调序号的 Responses 语义 SSE 事件。
- **Compatibility Fixture**: 可重复的脚本化上游交互，连同对 Bridge 可观察结果的预期，用于验证协议与故障契约。
- **Service Runtime**: Node.js + TypeScript。
- **Bridge Configuration**: 部署方持有的单个 YAML 配置，声明 Bridge 认证、Upstream Pool 与运行策略；不从服务进程环境读取配置。
- **Upstream Pool**: 由 Bridge 配置文件声明的有序 Chat Completions 上游；请求失败时按顺序切换。
- **Upstream Capability Profile**: 启动配置显式声明的 Function Tool、双向 Custom Tool 与并行调用能力；Bridge 按请求筛选兼容上游。
- **Upstream Wire API**: 上游使用的 `chat` 或 `responses` 协议；Hosted Web Search 仅可使用声明 `responses` 且 `webSearch=true` 的上游。
- **State Store**: SQLite；保存响应、会话、工具调用与重试所需状态。
- **Idempotent Request**: 同一 Bridge Authentication 主体的 `POST /v1/responses`，以 `Idempotency-Key` 和规范化已接受请求的摘要识别；命中时复用同一 Response。
- **Bridge Authentication**: 客户端以 `Authorization: Bearer <API_KEY>` 访问受保护的桥接端点；上游密钥仅由服务持有。
- **Retention Policy**: 仅由部署方配置的全局状态保留、容量限制与清理策略；客户端不得通过请求或 API Key 覆盖。
- **Replay Window**: Response Chain、Output Item、Stream Event 与幂等记录从整条链最后一个终态 Response 起保留 30 天，以支持原始 SSE 重放；Attempt 保留 7 天。
- **State Capacity**: SQLite 状态库硬上限为 10 GiB；达到 8 GiB 时清理最旧的可删终态状态，无法回收时拒绝新请求。
- **State Cleanup**: 启动时及每小时清理；仅整链删除超过保留窗口的终态状态，容量回收同样按最旧可删链进行，绝不删除进行中状态。
- **State Capacity Rejection**: 状态库满 10 GiB 且同步清理无可回收状态时，新建请求以可重试的 `503 state_store_capacity_exceeded` 失败，且不得创建 Response、幂等记录或 Attempt；进行中请求继续完成。
- **State Cleanup Observability**: 每次清理记录起止时间、删除链数、回收字节数与失败原因；暴露当前状态库字节数和容量拒绝计数，且不得记录 Response 内容或密钥。

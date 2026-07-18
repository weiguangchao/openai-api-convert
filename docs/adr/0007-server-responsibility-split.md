# Server 职责拆分：纯 Stream Translator + Result + leaf http

`src/server.ts`（628 行）混着 HTTP 传输、请求流水线、协议翻译、Attempt 生命周期与 Failover 编排，且 `server.ts ↔ sse.ts` 已存在循环依赖（`sse.ts` 导入 `sendError`）。拆分对齐领域概念（Attempt / Failover Policy / Stream Event），并让单元能脱离 HTTP/上游独立测试。

决定：抽 leaf `http.ts`（`sendError`、`errorCodes`/`requestIds` WeakMap、`requireBridgeAuthentication`、`redactHeaders`），断 `sse↔server` 循环；`adapter.ts` 扩为双向——正向（`buildChatRequest` 等）+ 反向 `StreamTranslator` class，后者为纯协议转换（async generator 产出 `ResponseEvent`，实例暴露 `outputStarted`/`outputText`/`output`，不持有 `response`/`state`/`log`），Attempt 层负责 `sse()` 落库发射、超时 rearm 与结果分类；流水线函数去 `response` 入参、返 `Result<T, AppError>`（错误自带 status），编排器统一 `sendError`，`claimOrCreateResponse` 的 `reused` 分支抽到编排器；拆 `responses.ts` / `attempt.ts` / `failover.ts`，瘦身 `server.ts`。

## Considered Options

- **翻译器自带 state + 发射**（被否：可测性倒退，等于白拆）。
- **抛 typed `AppError` 异常**（被否：与现有 early-return 风格相悖，用异常做校验控制流）。
- **`RequestScope` 对象穿过流水线**（被否：改动面大，把传输状态拖进领域层，与对齐领域概念的目标相悖）。

# Express 重构评估：是否替换原生 `node:http` 服务器

> 研究文档（非最终 ADR）。评估将 `src/server.ts` 中基于 `node:http` `createServer` 的实现替换为 Express 框架的代价、收益与风险。
> 证据来源：Express 官方文档、Express GitHub 源码与 Release、npm registry、body-parser 官方 README。社区/二手资料已标注。

## 摘要与建议

**建议：不做。**（若路由/中间件需求未来显著增长，可改为「有条件地做」。）

核心依据：

- 当前仅 **4 条路由**，无路径参数、无查询解析复杂度，手写 `if` 链已足够清晰；Express 的路由层在此规模下**几无净收益**。
- 核心路径 `POST /v1/responses` 是**长连接 SSE 流**，深度依赖 `response.writeHead`/`response.write`/`response.end`/`response.writableEnded`/`response.once('close')`/`request.once('aborted')` 等底层语义。Express 的 `res` 虽继承自 `http.ServerResponse.prototype`（[源码确认](https://github.com/expressjs/express/blob/master/lib/response.js)），**不破坏**这些原语，但 `res.send`/`res.json` 等高层方法会设置 `Content-Length`/`ETag`，与 SSE 不兼容——迁移后仍需保留原始 `writeHead`+`write`，等于「换了壳、没换芯」。
- 引入 Express 5.2.1 会**新增 67 个传递依赖包**（实测 `npm install --dry-run`），而项目当前运行时依赖仅 3 个（`winston`、`winston-daily-rotate-file`、`yaml`），供应链面骤增。
- 性能上，SSE 流持续时间远大于每请求中间件开销，**per-request 开销在此场景被流时长淹没**（置信度：中——无第一方基准，属推理）。

结论：**当前手写路由是 4 条，Express 给 SSE 路径带来回归风险却收益甚微，不值得做。** 若未来路由扩展到 10+ 且需要参数化、查询解析、CORS、压缩等中间件生态，再重新评估。

---

## 现状回顾（已核实）

| 维度 | 现状 |
|---|---|
| HTTP 层 | `createServer`（`src/server.ts:2,608`），监听 `127.0.0.1`（`:609`） |
| 路由 | 手写 `if` 链匹配 `method`+`url`（`:146,166,171,182,188`），4 条路由 |
| 鉴权 | `requireBridgeAuthentication` 校验 `Authorization: Bearer`（`:75`） |
| Body 解析 | 手动 `for await (chunk of request)` 累积 + `JSON.parse`（`:220-221`），并保留 `rawBody` 用于 debug 日志 |
| SSE | `response.writeHead` + `sse()` helper（`src/sse.ts`），重度使用 `response.end()`/`writableEnded`/`once('close')`/`request.once('aborted')` |
| 错误响应 | `sendError()` 写 JSON + `x-request-id` 头（`:69`） |
| Request ID | 每请求 `randomUUID()`，存于 `WeakMap<ServerResponse, string>`（`:41`） |
| 运行时依赖 | `winston`、`winston-daily-rotate-file`、`yaml`（`package.json`） |
| 运行方式 | `node --experimental-strip-types src/index.ts`，`type: "module"`，`@types/node` ^24，TS ^5.8，无构建步骤 |
| 测试 | `node --test`；`test/bridge.test.ts` 仅通过 `startBridge` 黑盒 fetch 测试，不直接引用 `sendError`/`handleRequest` |

---

## 逐项调查

### 1. Express 现状与 Node 版本兼容性

- **最新版本**：Express 5.2.1 为 `latest`，4.22.2 为 `latest-4`（[npm registry](https://www.npmjs.com/package/express)）。
- **Express 5 已 GA**：5.0.x → 5.1.0 → 5.2.0 → 5.2.1 均已发布（[GitHub Releases](https://github.com/expressjs/express/releases)）。
- **Node 版本要求**：Express 5.x 要求 `node >= 18`（[FAQ](https://expressjs.com/en/starter/faq.html) 与 [迁移指南](https://expressjs.com/en/guide/migrating-5.html)）。`engines` 字段为 `{ node: '>= 18' }`（npm registry）。
- **Node 24 支持**：Express 5.2.0 的 CI 已加入 Node.js 24 测试矩阵（PR #6504），5.2.1 加入 Node 25（PR #6843）（[Release notes](https://github.com/expressjs/express/releases)）。项目用 `@types/node` ^24，兼容。

> 结论：版本与 Node 兼容性不是障碍。

### 2. SSE / 流式支持（关键风险点）

**结论：Express 不破坏原始流式语义，但其高层 helper 与 SSE 冲突；迁移后仍须保留 raw write。置信度：高（源码级证据）。**

- Express 的 `res` 原型直接派生自 Node 原生对象：`var res = Object.create(http.ServerResponse.prototype)`（[lib/response.js](https://github.com/expressjs/express/blob/master/lib/response.js)）。`res.write`/`res.writeHead`/`res.end`/`res.writableEnded`/`res.setHeader`/`res.on('close')` 全部原生继承，**不被包裹或缓冲**。
- `app.handle` 中 `Object.setPrototypeOf(req, this.request)` / `Object.setPrototypeOf(res, this.response)`（[lib/application.js](https://github.com/expressjs/express/blob/master/lib/application.js)）：原生 `req`/`res` 的原型被替换为 Express 原型（后者又继承自原生原型），原生流式 API 完整保留。
- `app.listen` 即 `http.createServer(this).listen(...)`，返回原生 `http.Server`，`server.address()`/`server.close()` 行为与现状一致。
- **但是** `res.send()`/`res.json()` 会设置 `Content-Length` 与 `ETag` 并调用 `res.end(chunk)`（见 `response.js` 中 `res.send`），对 `text/event-stream` 流是**错误**的（SSE 不可预知长度、不应设 ETag）。因此 `sse()`/`terminalSse()`/`replaySse()` 中的 `response.write(...)` 与 `response.writeHead(200, {'content-type':'text/event-stream', ...})` 必须**原样保留**，不能改用 `res.json`/`res.send`。
- `WeakMap<ServerResponse, string>` 以响应对象为键：由于 Express 的 `res` IS-A `ServerResponse`（原型链含 `http.ServerResponse.prototype`），`instanceof` 与 WeakMap 键语义不变。✓
- 客户端断连检测：`request.once('aborted')` 与 `response.once('close')` 均为原生事件，Express 不拦截。✓

> 净影响：SSE 路径**无法**因迁移而简化，迁移等于把 `createServer(handler)` 换成 `http.createServer(app)`，handler 内部仍是 raw Node 写法。这是「换了壳、没换芯」。

### 3. Body 解析

**结论：`express.json()` 与当前手动读取互斥；若采用需用 `verify` 捕获 raw body 并调高 `limit`。置信度：高。**

- `express.json()`（底层 `body-parser`）会消费 request 流并填充 `req.body`。若再手动 `for await (chunk of request)`，会触发 `stream is not readable` 错误（[body-parser README](https://github.com/expressjs/body-parser/blob/master/README.md) "Errors → stream is not readable"：当流已被其他读取者消费时抛出）。**二者不可混用。**
- **raw body 访问**：当前代码在 `logging.level === 'debug'` 时记录 `rawBody`（`:225-230`）。`express.json()` 提供 `verify(req, res, buf, encoding)` 回调，`buf` 即原始 body Buffer（[body-parser README](https://github.com/expressjs/body-parser/blob/master/README.md) "verify option"）。可在此把 `buf` 挂到 `req.rawBody` 以保留 debug 日志。
- **limit 默认 100kb**：body-parser 各 parser `limit` 默认 `'100kb'`（[README](https://github.com/expressjs/body-parser/blob/master/README.md)）。Bridge 接收的 `/v1/responses` payload（含 `tools`、`input`、历史链）**可能超过 100kb**，必须显式调高，否则 413。
- Express 5 的 `req.body` 在未解析时返回 `undefined`（[迁移指南](https://expressjs.com/en/guide/migrating-5.html) "req.body"），需注意判空。

> 采用 Express 的 body 解析会带来「raw body 捕获 + limit 调整」两处适配成本，且对 `/healthz`、`/readyz`、`/metrics` 无 body 的路由是纯开销（虽 `type` 不匹配时会跳过）。

### 4. 路由人机工程学

4 条路由映射到 Express：

```js
app.get('/healthz', ...);
app.get('/readyz', auth, ...);
app.get('/metrics', auth, ...);
app.post('/v1/responses', auth, ...);
app.use((req, res) => sendError(res, 404, 'Not found', 'not_found')); // 兜底
```

- 当前手写 `if` 链共 ~10 行（`:166-192`），无路径参数、无 query、无正则。
- Express 写法行数相近，**无明显简化**；唯一收益是鉴权可抽成 `auth` 中间件复用（当前 3 处调用 `requireBridgeAuthentication`）。
- Express 5 通配符语法变更（`*` 须命名，如 `/*splat`）（[迁移指南](https://expressjs.com/en/guide/migrating-5.html)），但本项目无通配符路由，不影响。

> 路由层收益几乎为零。鉴权中间件化是唯一微小改进，不构成迁移理由。

### 5. 性能 / 开销

**置信度：中（无第一方权威基准；以下为推理 + Express 自述）。**

- Express 自述 "Focus on high performance"（[README](https://github.com/expressjs/express)），但未给出与裸 `node:http` 的对比基准。社区基准（如 vs Fastify）多为二手，**不作为强证据**。
- 推理：每请求中间件管线（路由匹配、`finalhandler`、可选 body parser）有微秒级开销。但本项目核心路径是**长连接 SSE**（流持续秒至分钟级），per-request 中间件开销相对流时长可忽略。
- `x-powered-by` 头默认开启会多一次 `res.setHeader`（[application.js `app.handle`](https://github.com/expressjs/express/blob/master/lib/application.js)），可用 `app.disable('x-powered-by')` 关闭。
- 真正的开销在**依赖体积与启动期**，不在请求热路径。

> 性能不是迁移的阻碍，也不是迁移的动机。

### 6. 依赖与供应链影响

- 实测 `npm install express@5.2.1 --dry-run`：**新增 67 个包**；`express@4.22.2`：**68 个包**（含 `qs`、`body-parser`、`send`、`serve-static`、`accepts`、`type-is`、`debug`、`http-errors`、`iconv-lite` 等传递依赖）。
- 项目当前运行时依赖仅 3 个，供应链面极小。引入 Express 使传递依赖树膨胀约 22 倍。
- Express 4 历史上部分中间件（如旧 `qs`、`body-parser`）曾有维护与安全争议；Express 5 已更新到 `body-parser@^2.2.1`、`qs@^6.14.0`（[npm registry](https://www.npmjs.com/package/express)），近期有 CVE 修复记录（5.2.0 修 CVE-2024-51999，5.2.1 修 CVE-2025-13466）（[Releases](https://github.com/expressjs/express/releases)）。维护活跃度尚可，但依赖越多 = 安全审计面越大。

> 这是迁移最明确的负面：用 67 个传递依赖换取 4 条路由的「框架化」，性价比低。

### 7. TypeScript & ESM

- **ESM 导入**：Express README 首例即 `import express from 'express'`（[README](https://github.com/expressjs/express)）。Express 是 CommonJS 包，Node ESM interop 经 `cjs-module-lexer` 识别 `module.exports = express` 提供默认导出，`import express from 'express'` 正确。
- **`--experimental-strip-types` 兼容**：类型剥离只对本地 `.ts` 文件剥离类型注解，不影响 Node 对 `.js` CJS 包的解析与加载。项目已用同机制导入 `winston`（CJS），导入 Express 同理可行，**无需构建步骤**。
- **类型**：Express 5 **不自带类型**（npm `express` 包无 `types` 字段）。需另装 `@types/express`（5.0.6），其又依赖 `@types/body-parser`、`@types/serve-static`、`@types/express-serve-static-core`（[npm](https://www.npmjs.com/package/@types/express)）——均为 devDependency，不进运行时，但仍扩大类型依赖面。
- `tsconfig.json` 现为 `types: ["node"]`，需追加 `"@types/express"` 或移除 `types` 限制以自动纳入。

> 技术上可行，无阻塞；但 `@types/express` 与 Express 5 新 API 的类型完整度需在迁移时核验（如 `res.status` 范围校验、async handler 错误传递等新行为）。

### 8. 迁移风险（本代码库特定）

| 风险点 | 评估 |
|---|---|
| `response.writeHead`/`write`/`end` 语义 | 不变（Express `res` 继承自 `ServerResponse`）。✓ |
| `response.writableEnded` / `response.destroyed` | 不变（原生属性）。✓ |
| `request.once('aborted')` / `response.once('close')` | 不变（原生事件）。✓ |
| `WeakMap<ServerResponse, string>` 键 | 不变（`res` IS-A `ServerResponse`）。✓ |
| `x-request-id` 头在路由前置（`:145`） | 需移入 Express 全局中间件（`app.use`），`res.setHeader` 原生可用。✓ |
| `sendError(response, ...)` 签名 | `response: ServerResponse` 不变，函数体无需改。✓ |
| SSE 路径 `res.send`/`res.json` 误用 | 风险：若迁移者顺手改用 `res.json`，会破坏 SSE。需明确**保留 raw write**。⚠️ |
| `startBridge` 返回 `RunningBridge`（`url`/`close`） | `app.listen` 返回原生 `http.Server`，`server.address()`/`server.close()` 行为一致，对外签名不变。✓ |
| `finalhandler` 兜底 | 未匹配路由会走 `finalhandler` 而非当前 `sendError(404)`；需显式 `app.use(...)` 兜底以保持 404 JSON 格式一致。⚠️ |
| async handler 错误 | Express 5 会把 rejected promise 转 `next(err)`（[迁移指南](https://expressjs.com/en/guide/migrating-5.html)），需配错误中间件以保持 `{error:{...}}` 格式。⚠️ |
| `x-powered-by` 头 | 默认开启会泄露框架，且改变响应头集合；建议 `app.disable('x-powered-by')`。⚠️ |

### 9. 测试影响

- `test/bridge.test.ts` **仅** `import { startBridge } from '../src/server.ts'`（`:9`），全部用例通过 `startBridge` 黑盒 fetch（60+ 处调用），**不直接引用** `sendError`/`handleRequest`。保持 `startBridge(options): Promise<RunningBridge>` 签名与 HTTP 契约（路径、鉴权、SSE 文本格式、`x-request-id`）即可**测试零改动**。
- `test/release-smoke.test.ts` 为黑盒 fetch 对绑端口，同理不受影响。✓
- `test/adapter.test.ts`、`test/config.test.ts`、`test/package-scripts.test.ts` 不触及 HTTP 层。✓
- 唯一需注意：`finalhandler` 与 `x-powered-by` 可能改变 404 响应体与响应头，若 smoke 测试断言响应头集合需核对（当前 smoke 主要断言 status 与 SSE 语义）。

---

## 代价 / 收益 / 风险矩阵

| 维度 | 代价 | 收益 | 风险 |
|---|---|---|---|
| 依赖 | +67 传递依赖包；`@types/express` 等 devDep | — | 供应链审计面 ↑22×；未来 CVE 跟踪成本 |
| 路由 | 重写 4 条路由 + 兜底中间件 | 鉴权中间件化（微小） | 404 格式偏移（`finalhandler`） |
| SSE | **无法简化**，须保留 raw write | — | 迁移者误用 `res.json` 破坏 SSE |
| Body | `verify` 捕获 raw body + 调高 `limit` | 可用 `express.json` 替代手动读取 | 100kb 默认 limit 导致 413；与手动读取互斥 |
| 类型 | `tsconfig` 调整 + `@types/express` | 类型提示 | Express 5 新行为类型完整度待核验 |
| 测试 | 基本零改动（黑盒） | — | 响应头集合变化（`x-powered-by`） |
| 性能 | 启动期略增 | — | 可忽略（SSE 长连接） |

---

## 迁移要点（若仍决定执行）

1. **保留 SSE 原始写入**：`sse()`/`terminalSse()`/`replaySse()` 中 `response.write`/`writeHead`/`end` 原样不动，**禁用** `res.json`/`res.send` 于流式路径。
2. **全局中间件**：`app.disable('x-powered-by')`；`app.use((req,res,next)=>{ const id=randomUUID(); requestIds.set(res,id); res.setHeader('x-request-id',id); next(); })`。
3. **鉴权中间件**：抽 `const auth = (req,res,next)=> requireBridgeAuthentication(req,res,apiKey) ? next() : undefined`。
4. **Body**：`app.post('/v1/responses', auth, express.json({ limit: '2mb', verify:(req,_res,buf)=>{ (req as any).rawBody = buf; } }), handler)`；handler 内用 `req.body` + `req.rawBody`。
5. **404 兜底**：`app.use((req,res)=> sendError(res,404,'Not found','not_found'))` 保持 JSON 格式。
6. **错误中间件**：`app.use((err,req,res,next)=> sendError(res,500,err.message,'internal_error'))` 捕获 async handler rejected promise。
7. **启动**：`const server = app.listen(options.port ?? 0, '127.0.0.1', resolve)`，`close` 复用 `server.close()`。
8. **类型**：`tsconfig` 移除 `types` 限制或显式加入 `@types/express`；核验 `res.status` 范围校验等 Express 5 新行为。

---

## 结论

**不做。** 当前 4 条手写路由清晰且无复杂度，SSE 核心路径无法从 Express 受益（必须保留 raw write），而代价是 67 个传递依赖、body 解析适配、`finalhandler`/`x-powered-by`/async 错误等行为对齐成本，以及 SSE 被误用 `res.json` 的回归风险。收益仅限于「鉴权中间件化」这一微小改进，**性价比明显为负**。

**触发重评的条件**：路由增至 10+ 条、需要路径参数/查询解析/CORS/压缩/限流等中间件生态、或团队希望统一 web 框架标准。届时优先评估 Express 5 与 Fastify（后者原生 TS、性能更优、对流式更友好），而非默认 Express。

---

## 来源索引（一手为主）

- Express 官方迁移指南（v5）：https://expressjs.com/en/guide/migrating-5.html
- Express 官方 FAQ（Node 版本）：https://expressjs.com/en/starter/faq.html
- Express GitHub Releases：https://github.com/expressjs/express/releases
- Express README（ESM `import` 用法）：https://github.com/expressjs/express
- Express 源码 `lib/response.js`（`res` 派生自 `http.ServerResponse.prototype`）：https://github.com/expressjs/express/blob/master/lib/response.js
- Express 源码 `lib/application.js`（`app.handle` 原型替换 / `app.listen` = `http.createServer`）：https://github.com/expressjs/express/blob/master/lib/application.js
- body-parser 官方 README（`verify`、`limit`、`stream is not readable`）：https://github.com/expressjs/body-parser/blob/master/README.md
- npm registry `express`（`engines`、依赖、dist-tags）：https://www.npmjs.com/package/express
- npm registry `@types/express`（版本与依赖）：https://www.npmjs.com/package/@types/express
- 依赖计数：本地 `npm install express@5.2.1 --dry-run`（`added: 67`）与 `express@4.22.2`（`added: 68`）
- Node.js HTTP 文档（`ServerResponse` 原语语义）：https://nodejs.org/api/http.html

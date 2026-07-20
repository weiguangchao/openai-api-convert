# SQLite ORM 评估：Node.js + TypeScript 项目中操作 SQLite 的框架选型

> 研究文档（非最终 ADR）。评估在 Responses Bridge 项目中引入 ORM/查询构建器操作 SQLite 的代价、收益与风险，候选：Prisma、Drizzle ORM、TypeORM、Sequelize、Kysely、better-sqlite3（基线）。
> 证据来源：各框架官方文档、GitHub 仓库源码/README/Releases、npm registry API、Node.js 官方 TypeScript 文档。社区/二手资料已标注，未作为强证据。

## 摘要与建议

**建议：优先 better-sqlite3 + 手写 SQL（基线）；若需要类型安全查询与声明式迁移，选 Drizzle ORM（配 better-sqlite3 驱动）。**

核心依据：

- 本项目核心约束是 **`node --experimental-strip-types` 无构建步骤** + **极简运行时依赖（当前仅 3 个）** + **ESM**。这两条筛掉了大半候选。
- **TypeORM 与 Sequelize v7 默认依赖装饰器实体**，而 Node 类型剥离**明确不支持装饰器**（会抛解析错误，[Node.js TS 文档](https://nodejs.org/api/typescript.html)）。TypeORM 虽有 `EntitySchema` 非装饰器方案、Sequelize v6 有 `Model.init` 非装饰器方案，但均为「绕路」而非主线，且各自另有体积/依赖/维护问题。
- **Prisma** 必须 codegen（`prisma generate` 生成 `.ts`），且 `@prisma/client` unpacked 75.3 MB、整体安装 125+ MB，WASM query compiler 同步运行在主线程——与极简依赖哲学**严重冲突**。
- **Drizzle ORM**：0 运行时依赖（所有驱动列为 optional peerDep）、schema→类型**编译期推断无需 codegen**、pure ESM + dual、`sideEffects: false`，是唯一同时满足「无构建」「极简依赖」「类型安全」三者的 ORM。
- **Kysely**：0 运行时依赖、pure ESM、类型安全查询构建器，但 API 为异步，**削弱了 better-sqlite3 同步驱动的性能优势**；且 schema 类型需手写 `Database` 接口。
- **better-sqlite3（基线）**：同步 API（官方基准 2.9x–24.4x 优于异步 `sqlite3`）、WAL 一等支持、事务/prepared statement 完备、2 个运行时依赖。代价是无 schema 类型推导、无内置迁移——对本地状态持久化（请求日志、映射表）这类简单场景**足够**，且与项目「不为本不需要的复杂度买单」的气质一致（参见 [Express 评估](./express-refactor-evaluation.md) 同样的结论逻辑）。

结论：**schema 简单（≤5 张表、以日志/映射为主）时用 better-sqlite3 手写 SQL；schema 开始复杂、需要类型安全查询构建与声明式迁移时升级到 Drizzle。两者共享同一个底层驱动 better-sqlite3，迁移路径平滑。** Prisma/TypeORM/Sequelize/Kysely 在本项目语境下性价比均为负。

---

## 评估维度

| 维度 | 说明 |
|---|---|
| TypeScript 支持 | 是否内置类型、schema→类型推导方式（codegen / 编译期推断 / 手写接口）、是否需要 `@types/*` |
| 无构建兼容 | 是否兼容 `node --experimental-strip-types`（仅类型剥离，不 transpile 装饰器/enum/参数属性）；是否必须运行 codegen 产生运行时 import 的产物 |
| 迁移机制 | 声明式 schema vs 命令式迁移文件；CLI 工具；运行时迁移器 |
| SQLite 支持 | 是否一等支持；底层驱动（better-sqlite3 / sqlite3 / node:sqlite / sql.js）；WAL、事务、并发 |
| 性能 | 同步 vs 异步 API；官方基准；事件循环影响 |
| 包体积/依赖 | unpacked size、运行时依赖数、是否有 native 模块（node-gyp 编译） |
| 社区活跃度 | GitHub Star、近期 release、提交频率 |
| 学习曲线 | API 风格、概念数量（基于官方文档判断） |

> 关键筛选逻辑：本项目用 `node --experimental-strip-types`（无构建），**任何依赖装饰器的方案直接出局或需绕路**；运行时依赖仅 3 个，**体积/依赖数是硬约束**。

---

## 逐个框架分析

### 1. Prisma

- **版本**：`prisma` 7.8.0 + `@prisma/client` 7.8.0，发布 2026-04-22。`latest=7.8.0`，`prev=6.19.x`。来源：[npm prisma](https://registry.npmjs.org/prisma) · [@prisma/client](https://registry.npmjs.org/@prisma/client) · [GitHub Releases](https://github.com/prisma/prisma/releases)
- **TS 支持**：两包均内置 `types` 字段，无需 `@types/*`。schema→类型经 **codegen**：`prisma generate` 读 `schema.prisma` 输出纯 `.ts` 到 `output` 目录；`prisma-client` 生成器支持 `moduleFormat: "esm"` + `generatedFileExtension: "ts"`。来源：[Generators 文档](https://www.prisma.io/docs/orm/prisma-schema/overview/generators)
- **迁移**：声明式 `schema.prisma` + `prisma migrate dev/deploy`（shadow database 检测 drift）；`prisma db push` 原型直推。**SQLite 无 advisory locking**（仅 PG/MySQL/SQL Server 支持）。来源：[migrate 文档](https://www.prisma.io/docs/orm/prisma-migrate/workflows/development-and-production)
- **SQLite**：一等支持（`provider = "sqlite"`）；底层 **better-sqlite3**（同步 native 绑定），可选 driver adapter `@prisma/adapter-better-sqlite3`。事务支持 `$transaction`（含交互式 + 嵌套 savepoint，7.5.0+）。**WAL 模式官方文档未提及**，Prisma 不暴露 pragma 接口（driver adapter 可访问底层 DB 实例）。known limitations：SQLite 不强制 enum、迁移无 advisory locking、DateTime 默认 ISO 8601。来源：[SQLite 文档](https://www.prisma.io/docs/orm/overview/databases/sqlite)
- **无构建兼容**：`@prisma/client` dual（ESM+CJS）；生成的 client 设 `moduleFormat=esm`+`importFileExtension=ts` 后**理论上**兼容 type stripping，但**未找到官方明确声明支持 `--experimental-strip-types`**。`prisma generate` 是必需步骤（虽生成 `.ts` 非 transpile，但增加流程复杂度）。better-sqlite3 为 native 模块（`prebuild-install || node-gyp rebuild`）。
- **活跃度**：~47k Star，月度发布节奏，npm `modified` 2026-07-16。来源：[GitHub](https://github.com/prisma/prisma)
- **体积**：`prisma` 40.0 MB + `@prisma/client` **75.3 MB**（内含 WASM query compiler runtime）+ `better-sqlite3` 9.9 MB ≈ **125+ MB** unpacked。来源：[npm](https://registry.npmjs.org/@prisma/client/7.8.0)
- **性能**：Client API 异步，但底层 better-sqlite3 同步；Prisma 7 的 query compiler 作为 **WASM 模块同步运行在 JS 主线程**（单次编译 0.1–1ms），7.4.0+ 有 query plan LRU 缓存。**未找到官方基准**。来源：[7.4.0 release](https://github.com/prisma/prisma/releases)
- **优势**：DX 优秀、schema 即文档、迁移系统完整、社区大、Prisma 7 消除 native query engine 二进制（WASM 替代）。
- **劣势**：**必须 codegen**；**体积巨大（125+ MB）与极简依赖哲学严重冲突**；WASM 主线程阻塞；SQLite WAL 不可配置；迁移无 advisory locking。
- **关键不确定性**：`--experimental-strip-types` 实际兼容性无官方声明；WAL 在内置 driver 下是否启用未知。

### 2. Drizzle ORM

- **版本**：稳定版 `drizzle-orm@0.45.2`（2026-03-27）+ `drizzle-kit@0.31.10`（2026-03-17）；`latest=0.45.2`，`rc=1.0.0-rc.4`（2026-06-27）。**官方文档安装命令已对齐 rc 通道**（`npm i drizzle-orm@rc`）。来源：[npm drizzle-orm](https://registry.npmjs.org/drizzle-orm) · [drizzle-kit](https://registry.npmjs.org/drizzle-kit) · [get-started-sqlite](https://orm.drizzle.team/docs/get-started-sqlite)
- **TS 支持**：内置 `types: ./index.d.ts`，无需 `@types/*`。schema→类型**编译期推断**：在 `.ts` 中调 `sqliteTable()`/`text()`/`integer()` 等构建器，TS 直接从返回类型推导列类型与 select/insert 行类型。**不需要为类型运行任何 generate 命令**；`drizzle-kit generate` 仅产出 SQL 迁移文件（`migration.sql` + `snapshot.json`），不被运行时 import。来源：[migrations 文档](https://orm.drizzle.team/docs/migrations)
- **迁移**：声明式 schema（TS 中的 `sqliteTable`）+ `drizzle-kit` CLI：`generate`/`migrate`/`push`/`pull`/`export`/`check`；运行时迁移器 `import { migrate } from 'drizzle-orm/better-sqlite3/migrator'`。`drizzle-kit` 内部用 `tsx`+`esbuild` 直接读 `.ts` schema。rc.2 引入迁移树冲突检测。来源：[migrations](https://orm.drizzle.team/docs/migrations) · [rc.2 release](https://github.com/drizzle-team/drizzle-orm/releases)
- **SQLite**：一等支持，三驱动：`better-sqlite3`（同步 native）、`node:sqlite`（Node 内置 `DatabaseSync`）、`libsql`。better-sqlite3 驱动为**同步** API（源码 `BaseSQLiteDatabase<'sync', ...>`）。事务 `db.transaction()` + 嵌套 savepoint + `rollback`。**WAL/pragma 官方文档未提及**，需 `db.run('PRAGMA journal_mode = WAL')` 透传。**关键限制：`node:sqlite` 导出不在稳定版 0.45.2**（exports 中 `./node-sqlite` 为 false），仅在 `1.0.0-rc.4`。来源：[get-started-sqlite](https://orm.drizzle.team/docs/get-started-sqlite) · [better-sqlite3 driver 源码](https://github.com/drizzle-team/drizzle-orm/blob/main/drizzle-orm/src/better-sqlite3/driver.ts) · [npm 0.45.2 exports](https://registry.npmjs.org/drizzle-orm/latest)
- **无构建兼容**：`drizzle-orm` pure ESM + dual（`import`→`.js` / `require`→`.cjs`），`sideEffects: false`。**完全兼容 type stripping**：包本身预编译为 `.js`，用户 `.ts` schema/应用经 Node 剥离类型即可运行，**无需 codegen 产物作为运行时 import**。来源：[npm package.json](https://registry.npmjs.org/drizzle-orm/latest)
- **活跃度**：~35,177 Star，最近提交 2026-07-10（当日 8 次），开发活跃。来源：[GitHub](https://github.com/drizzle-team/drizzle-orm)
- **体积**：`drizzle-orm` unpacked ~10.4 MB（fileCount 2666），但 **`dependencies` 字段缺失（0 运行时依赖）**，所有驱动列 `peerDependencies` 且全 `optional: true`——安装 `drizzle-orm` 不拉任何驱动。`drizzle-kit` ~10.3 MB（devDep，含 tsx/esbuild）。better-sqlite3 native。来源：[npm](https://registry.npmjs.org/drizzle-orm/latest)
- **性能**：官方表述「thin TypeScript layer on top of SQL with almost 0 overhead」，提供 prepared statements API。rc.1 引入 opt-in JIT mappers（PG 基准称 25–30% 延迟下降）。**未找到 SQLite 专属官方基准**。better-sqlite3 同步驱动本身是 Node 下最快 SQLite 驱动之一。来源：[performance 文档](https://orm.drizzle.team/docs/performance) · [rc.1 release](https://github.com/drizzle-team/drizzle-orm/releases)
- **优势**：0 运行时依赖契合极简哲学；编译期类型推断无需 codegen；pure ESM + dual；SQLite 一等支持 + 同步 API；迁移灵活（push/generate+migrate/runtime migrate/pull）；tree-shakeable。
- **劣势**：稳定版 0.45.2 **不含 `node:sqlite` 驱动**（零 native 路线须切 rc.4，有 breaking change）；better-sqlite3 路线引入 native 模块；SQLite WAL/pragma 无官方 API（需原始 SQL）；SQLite 事务隔离无 Drizzle 层配置；1.0.0 仍 rc，稳定版已 4 个月未更新。
- **关键不确定性**：SQLite 专属官方基准未找到；WAL 支持无官方说明（推断透传）；`node:sqlite` 在 Node 24 的 stable/experimental 标记未核实。

### 3. TypeORM

- **版本**：`1.1.0`，发布 2026-07-13。`latest=1.1.0`，`legacy=0.3.31`。engines `node ^20.19.0 || ^22.13.0 || >=24.11.0`。来源：[GitHub Releases](https://github.com/typeorm/typeorm/releases) · [package.json](https://raw.githubusercontent.com/typeorm/typeorm/master/package.json)
- **TS 支持**：内置 `types: ./index.d.ts`，`exports` 各条件均带 `types`。默认 schema 定义方式：**装饰器**（`@Entity()`/`@Column()` + `reflect-metadata` 运行时反射），无 codegen。替代方案 **`EntitySchema`**（配置对象 `new EntitySchema<T>({...})`，非装饰器，同样类型安全）。来源：[EntitySchema 文档](https://raw.githubusercontent.com/typeorm/typeorm/master/docs/docs/entity/6-separating-entity-definition.md)
- **迁移**：命令式 `MigrationInterface`（`up`/`down`），CLI `migration:generate` 对比实体与 DB 生成 SQL；`migrationsTransactionMode: all/none/each`。**CLI 对 TS 实体需 ts-node 转译**（`typeorm-ts-node-esm`），对无构建项目是额外依赖；可程序化 `dataSource.runMigrations()` 绕开 CLI。来源：[migrations setup](https://raw.githubusercontent.com/typeorm/typeorm/master/docs/docs/migrations/02-setup.md) · [using-cli](https://raw.githubusercontent.com/typeorm/typeorm/master/docs/docs/using-cli.md)
- **SQLite**：一等支持，驱动 **better-sqlite3**（native）或 `sql.js`（WASM）。**不支持 `node:sqlite`**。WAL 有数据源选项 `enableWAL`（默认 false）；`timeout`（默认 5000ms）控制锁等待；`statementCacheSize`（默认 100）；支持 SQLCipher `key`、`nativeBinding`、`prepareDatabase`。来源：[SQLite 文档](https://typeorm.io/docs/drivers/sqlite)
- **无构建兼容**：dual ESM/CJS，包自身无需 codegen。**致命冲突：默认装饰器实体与 `--experimental-strip-types` 不兼容**——Node 官方明确「Decorators are currently a TC39 Stage 3 proposal, they are not transformed and will result in a parser error」（[Node.js TS 文档](https://nodejs.org/api/typescript.html)）。`--experimental-transform-types` 也不覆盖装饰器（且该 flag 已在 Node v26 移除）。**可行路径：改用 `EntitySchema`**（无装饰器，可与类型剥离共存），但这是非主线用法。来源：[Node.js TS 文档](https://nodejs.org/api/typescript.html) · [EntitySchema 文档](https://raw.githubusercontent.com/typeorm/typeorm/master/docs/docs/entity/6-separating-entity-definition.md)
- **活跃度**：~36,597 Star，最近 push 2026-07-17，1.0.0 近期发布（大版本 breaking）。来源：[GitHub](https://github.com/typeorm/typeorm)
- **体积**：unpacked ~20.6 MB，**10 个运行时依赖**（ansis、dayjs、debug、tslib、yargs、dedent、tinyglobby、sql-highlight、reflect-metadata、@sqltools/formatter）+ better-sqlite3。来源：[package.json](https://raw.githubusercontent.com/typeorm/typeorm/master/package.json)
- **性能**：底层 better-sqlite3 同步，但 TypeORM 对外统一**异步 Promise API**，掩盖同步优势。**未找到官方基准**。
- **优势**：成熟、生态广、SQLite 一等支持（WAL/事务/加密/只读齐备）；`EntitySchema` 可规避装饰器冲突；迁移可程序化执行。
- **劣势**：**装饰器与 type stripping 直接冲突**（解析错误），必须改 `EntitySchema`（非主线）；10 个运行时依赖 + native 模块与极简哲学冲突；CLI 需 ts-node；体积偏大；对外异步封装掩盖同步优势。
- **关键不确定性**：SQLite 专用 known limitations 清单未找到；`EntitySchema` 在 type stripping 下的官方背书未找到（基于 Node 规则 + 无装饰器特性推断）；是否计划支持 `node:sqlite` 未找到。

### 4. Sequelize

- **版本**：稳定版 `v6.37.8`（2026-03-07）；`v7.0.0-alpha.48`（2026-02-04，仍 alpha）。v7 拆为多包（`@sequelize/core` + `@sequelize/sqlite3`）。**仓库公告「Seeking New Maintainers」**，v7 推进缓慢。来源：[npm sequelize](https://registry.npmjs.org/sequelize) · [GitHub](https://github.com/sequelize/sequelize)
- **TS 支持**：内置类型（v6 `types: ./types/index.d.ts`，v7 `@sequelize/core` `types: ./lib/index.d.ts`）。类型推导：`InferAttributes<Model>`/`InferCreationAttributes<Model>` 从已声明类字段推断，**无需 codegen**。官方明确「Our TypeScript support does not follow SemVer」。v7 推荐**装饰器 API**（`@Attribute`/`@Table`）。来源：[v6 TS 文档](https://sequelize.org/docs/v6/other-topics/typescript/) · [v7 defining-models](https://sequelize.org/docs/v7/models/defining-models/)
- **迁移**：命令式 `up`/`down` + `queryInterface`，CLI（v6 `sequelize-cli`，v7 `@sequelize/cli`）；迁移记录存 `SequelizeMeta` 表；底层用 umzug。`sequelize.sync()` 仅开发期。来源：[v6 migrations](https://sequelize.org/docs/v6/other-topics/migrations/) · [v7 migrations](https://sequelize.org/docs/v7/models/migrations/)
- **SQLite**：一等支持，底层驱动 **`sqlite3`**（原生 N-API C++ 模块，`prebuild-install || node-gyp rebuild`，**非 better-sqlite3**）。事务支持完整（savepoint、隔离级别、`afterCommit`）。`:memory:` 需 `pool: { max: 1 }`。`dialectOptions.mode` 可设打开模式。**WAL 模式官方文档未提及**。官方安全提示：`sqlite3@^4` 有漏洞，推荐 `@vscode/sqlite3` fork 或升 `^5.0.3`。来源：[v6 dialect-specific](https://sequelize.org/docs/v6/other-topics/dialect-specific-things/) · [v7 SQLite](https://sequelize.org/docs/v7/databases/sqlite/) · [npm sqlite3](https://registry.npmjs.org/sqlite3/latest)
- **无构建兼容**：v6 dual ESM/CJS，`Model.init`（非装饰器）+ `InferAttributes` 推断，**可直接在 type stripping 下运行**。v7 推荐**装饰器 API**，官方明确「Using legacy decorators requires to use a transpiler such as TypeScript, Babel or others to compile them」——**与 `--experimental-strip-types` 不兼容**；v7 非装饰器 legacy API 被「discouraged」且 v7 仍 alpha。来源：[v7 defining-models](https://sequelize.org/docs/v7/models/defining-models/) · [npm v6](https://registry.npmjs.org/sequelize/6.37.8)
- **活跃度**：~30,374 Star，最近 push 2026-07-16；但「寻找新维护者」公告 + v7 长期 alpha（序号到 48，跨度超 2 年）。来源：[GitHub](https://github.com/sequelize/sequelize)
- **体积**：v6 unpacked 2.77 MB，**16 个运行时依赖**（含 `moment`、`moment-timezone`、`lodash`、`validator`、`uuid`、`wkx` 等）；v7 `@sequelize/core` 18 依赖（以 `dayjs` 取代 moment）。`sqlite3` native。来源：[npm v6](https://registry.npmjs.org/sequelize/6.37.8)
- **性能**：全程**异步 promise-based**，底层 `sqlite3` 为异步回调驱动（与 better-sqlite3 同步模型不同）。**未找到官方基准**。
- **优势**：成熟稳定、生态广、文档全；v6 非装饰器 API 兼容 type stripping；事务/关联/eager loading 齐全。
- **劣势**：**v7（未来方向）装饰器硬依赖 transpiler，不适合无构建**；v6 依赖 `sqlite3`（非 better-sqlite3）native 模块 + 16 个运行时依赖（含 moment），与极简哲学冲突；`sqlite3` 异步驱动单次查询延迟通常高于同步 better-sqlite3；v7 长期 alpha + 寻找新维护者，升级路径不确定。
- **关键不确定性**：WAL 内建开关未找到官方说明；v7 非装饰器 legacy API 在 type stripping 下的官方兼容性声明未找到；官方性能基准未找到。

### 5. Kysely（查询构建器，非严格 ORM）

- **版本**：`0.29.4`，发布 2026-07-17（昨日）。`latest=0.29.4`。engines `node >=22.0.0`。来源：[npm kysely](https://registry.npmjs.org/kysely) · [GitHub Releases](https://github.com/kysely-org/kysely/releases)
- **TS 支持**：内置类型（`exports` 通过 `types@<5.4` 条件为旧 TS 提供 `outdated-typescript.d.ts`，TS ≥5.4 用 `dist/**/*.d.ts`）。最低 TS 5.4（项目 ^5.8 满足）。schema→类型：**手动定义 `Database` 接口**（表名为键、表 schema 接口为值），提供 `Generated`/`Selectable`/`Insertable`/`Updateable`/`ColumnType` 辅助类型。codegen **可选非必需**（官方列第三方 `kysely-codegen`/`prisma-kysely` 等，但原话手动定义「在多数情况下已足够」）。来源：[getting-started](https://kysely.dev/docs/getting-started) · [generating-types](https://kysely.dev/docs/generating-types)
- **迁移**：命令式 `up`/`down`（`export async function up(db: Kysely<any>)`），`Migrator` + `FileMigrationProvider`，`migrator.migrateToLatest()`。**数据库级锁**，并行调用串行执行，崩溃自动释放——多实例可安全并发。CLI `kysely-ctl` 为独立包，官方声明「It is not part of the core, and your mileage may vary」。来源：[migrations](https://kysely.dev/docs/migrations)
- **SQLite**：一等支持，5 内置 dialect 之一（`SqliteDialect`），驱动 **better-sqlite3**（同步 native）。事务 `db.transaction()`；0.29.0 引入 `supportsMultipleConnections` adapter flag + 集中连接 mutex 针对 SQLite 单连接特性。0.29.4 修复 SQLite `returning` 在 `delete+order by+limit` 的 bug。**WAL 官方文档无专门页面**，可通过 `sql\`PRAGMA journal_mode=WAL\`` 执行。来源：[dialects](https://kysely.dev/docs/dialects) · [SqliteDialect API](https://kysely-org.github.io/kysely-apidoc/classes/SqliteDialect.html) · [0.29.0 release](https://github.com/kysely-org/kysely/releases)
- **无构建兼容**：**pure ESM**（`"type": "module"`），无 CJS dual。完全兼容 type stripping：包本身预编译 `dist/*.js`，用户 `.ts` 仅剥离类型。**无需 codegen 产物作为运行时 import**。来源：[npm](https://registry.npmjs.org/kysely)
- **活跃度**：~14,054 Star，最近 push 2026-07-17，近 30 天 17 个提交，维护稳定。来源：[GitHub](https://github.com/kysely-org/kysely)
- **体积**：unpacked ~1.72 MB（fileCount 610），**0 运行时依赖**（仅 devDependencies）。better-sqlite3 native（列在 devDeps，生产由用户作 peer 安装）。来源：[npm](https://registry.npmjs.org/kysely)
- **性能**：API **异步 Promise-based**，底层 better-sqlite3 同步——**异步包装削弱了同步驱动的性能优势**（无法用同步返回值）。0.29.0 起支持 `AbortSignal` 查询取消。仓库 `bench:ts` 脚本为 **TS 编译性能基准，非 SQL 运行时**。**未找到官方运行时基准**。来源：[getting-started](https://kysely.dev/docs/getting-started)
- **优势**：类型安全查询构建器、SQL 透明可控；pure ESM + 0 运行时依赖；类型随包内置无需 codegen；SQLite 一等支持；迁移机制成熟（DB 级锁）。
- **劣势**：异步 API 包装 better-sqlite3 同步能力，**无法直接利用同步高吞吐**；schema 类型需手动维护（或引入第三方 codegen）；pure ESM 无 dual；仍 0.x（API 可能在 minor 间变动）；Node ≥22 硬性要求。
- **关键不确定性**：WAL 官方支持说明未找到；运行时性能基准未找到；`kysely-ctl` CLI 成熟度未深入核查。

### 6. better-sqlite3（手写 SQL 基线）

- **版本**：npm `latest` `12.11.1`（2026-06-15）；GitHub 最新 `v12.12.0`（2026-07-15，**未发布到 npm**）。engines `node 20.x || 22.x || 23.x || 24.x || 25.x || 26.x`。来源：[npm latest](https://registry.npmjs.org/better-sqlite3/latest) · [GitHub Releases](https://github.com/WiseLibs/better-sqlite3/releases)
- **TS 支持**：**包不内置类型**（无 `types`/`exports` 字段），需 `@types/better-sqlite3`（DefinitelyTyped）。schema→类型**无自动推导**：`prepare()` 的 `Result` 默认 `unknown`，需手动传泛型 `prepare<[string], { name: string }>('SELECT ...')`。无 codegen。来源：[@types index.d.ts](https://github.com/DefinitelyTyped/DefinitelyTyped/blob/master/types/better-sqlite3/index.d.ts)
- **迁移**：**无内置迁移系统**。推荐用 `db.exec(string)` 执行多条 SQL（官方 API 文档示例即迁移场景）；用户需自行实现版本管理（如 `PRAGMA user_version` + 条件执行）或搭配第三方工具。来源：[API exec()](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md)
- **SQLite**：**本身即驱动**（原生 C++ addon 绑定 SQLite C API）。WAL 一等支持，官方强烈推荐 `db.pragma('journal_mode = WAL')`。事务 `db.transaction(fn)` 自动 BEGIN/COMMIT/ROLLBACK，支持嵌套（savepoint）、`deferred`/`immediate`/`exclusive` 变体，**不支持 async 函数**。prepared statement API 完备（`run`/`get`/`all`/`iterate`/`pluck`/`expand`/`raw`/`bind`/`columns`）。还支持用户函数/聚合/虚拟表/扩展加载/backup/serialize/64 位整数/worker thread。known limitations：高并发写入不适合（建议 PostgreSQL）；WAL 默认 `synchronous=NORMAL` 有轻微耐久性损失；WAL 可能 checkpoint starvation；事务函数中 SQLite 可能因 `ON CONFLICT`/`RAISE()`/`SQLITE_FULL`/`SQLITE_BUSY` 自动回滚。来源：[README](https://github.com/WiseLibs/better-sqlite3/blob/master/README.md) · [api.md](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md) · [performance.md](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/performance.md)
- **无构建兼容**：**CJS 包**（`main: lib/index.js`，无 `type`/`exports`），通过 Node CJS-ESM interop 工作。官方 README 明确展示 ESM 用法 `import Database from 'better-sqlite3'`。**兼容 type stripping**：类型剥离仅移除用户 `.ts` 类型注解，运行时 import 解析为 CJS 默认导出。**无需 codegen**。要求：`tsconfig.json` 启用 `esModuleInterop: true`（因 `@types` 用 `export = Database`）。来源：[README](https://github.com/WiseLibs/better-sqlite3/blob/master/README.md) · [npm](https://registry.npmjs.org/better-sqlite3/latest)
- **活跃度**：~7,363 Star，最近 push 2026-07-17，近 30 天 5 次提交，2026 年内 7 个 npm 发布，维护稳定。来源：[GitHub](https://github.com/WiseLibs/better-sqlite3)
- **体积**：unpacked ~9.9 MB（fileCount 49），**2 个运行时依赖**（`bindings`、`prebuild-install`）。native 模块（`prebuild-install || node-gyp rebuild`）。来源：[npm](https://registry.npmjs.org/better-sqlite3/latest)
- **性能**：**同步 API**。官方论点：SQLite 本身序列化执行，同步 API 避免异步开销和 mutex 竞争，「better concurrency than an asynchronous API... yes, you read that correctly」。**有官方基准**（2020-03, Node v12.16.1, WAL）：逐行 `get()` 313,899 ops/s（vs node-sqlite3 26,780，**11.7x**）；`all()` 100 行 8,508 ops/s（**2.9x**）；`iterate()` 100 行 6,532 ops/s（**24.4x**）；事务内插 100 行 4,141 ops/s（**15.6x**）。声明：「2000 qps with 5-way-joins in a 60 GB database」。来源：[benchmark.md](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/benchmark.md) · [README](https://github.com/WiseLibs/better-sqlite3/blob/master/README.md)
- **优势**：极简依赖（2 个）；无 codegen/无构建；同步 API 对本地状态持久化天然合适且性能最优；SQLite 功能完整覆盖（WAL/事务/函数/虚拟表/backup）；成熟稳定（2016 年至今）；ESM 兼容。
- **劣势**：native 模块编译（非 LTS Node/冷门平台需 node-gyp + C++ 工具链）；无内置类型（需 `@types`）；无 schema→类型推导（查询结果默认 `unknown`，需手写泛型）；无内置迁移系统；同步 API 阻塞事件循环（慢查询需 worker thread，但本地状态场景影响极小）；CJS 包（需 `esModuleInterop`）；事务不支持 async；npm 落后 GitHub 一个月。
- **关键不确定性**：v12.12.0 未发布到 npm 的原因未找到官方说明；`--experimental-strip-types` 官方测试背书未找到（基于 interop 机制推断）；预编译二进制的精确平台矩阵未在文档列出。

---

## 对比表格

| 维度 | Prisma 7.8 | Drizzle 0.45.2 | TypeORM 1.1.0 | Sequelize 6.37.8 | Kysely 0.29.4 | better-sqlite3 12.11.1 |
|---|---|---|---|---|---|---|
| 类型推导 | codegen `.ts` | 编译期推断 | 装饰器反射 / EntitySchema | `InferAttributes` 推断 | 手写 `Database` 接口 | 无（手写泛型） |
| 需 codegen | **是**（必需） | 否 | 否 | 否 | 否（可选） | 否 |
| 迁移 | 声明式 + CLI | 声明式 + CLI/runtime | 命令式 + CLI | 命令式 + CLI(umzug) | 命令式 + runtime | **无**（自行实现） |
| SQLite 驱动 | better-sqlite3 | better-sqlite3 / node:sqlite(rc) | better-sqlite3 / sql.js | **sqlite3**(异步) | better-sqlite3 | 本身 |
| WAL 支持 | 不暴露 | 原始 SQL 透传 | `enableWAL` 选项 | 未提及(原始 SQL) | 原始 SQL 透传 | **一等**(`pragma`) |
| 事务 | `$transaction`+savepoint | `transaction`+savepoint | 支持 | 完整(隔离级别) | `transaction` | `transaction`+savepoint |
| API 模式 | 异步(WASM 同步阻塞) | **同步**(better-sqlite3) | 异步 | 异步 | 异步 | **同步** |
| 无构建兼容 | 理论可行(无官方背书) | **完全兼容** | ❌ 装饰器冲突(EntitySchema 绕路) | v6 可行 / v7❌ | **完全兼容** | **兼容**(需 esModuleInterop) |
| 运行时依赖 | 多(@prisma/client 含 WASM) | **0** | 10 | 16 | **0** | 2 |
| unpacked 体积 | **125+ MB** | ~10.4 MB(按 subpath 加载) | ~20.6 MB | 2.77 MB | ~1.72 MB | ~9.9 MB |
| native 模块 | 是(better-sqlite3) | 是(better-sqlite3)/否(node:sqlite rc) | 是 | 是(sqlite3) | 是(better-sqlite3) | 是 |
| GitHub Star | ~47k | ~35k | ~36.6k | ~30k | ~14k | ~7.4k |
| 官方基准 | 无 | PG 有,SQLite 无 | 无 | 无 | 无(TS 编译基准) | **有**(2.9–24.4x) |
| 学习曲线 | 中(schema 语法) | 低(SQL-like) | 中-高(装饰器/EntitySchema) | 中-高(关联复杂) | 低(SQL-like) | 低(SQL) |

---

## 针对本项目的推荐结论与理由

### 决策矩阵

| 候选 | 无构建兼容 | 极简依赖契合 | SQLite 适配 | 类型安全 | 结论 |
|---|---|---|---|---|---|
| Prisma | 理论可行(无背书) | ❌ 125+ MB | WAL 不可配 | ✅ | **不推荐**：体积/依赖严重超标 |
| Drizzle | ✅ 完全 | ✅ 0 运行时依赖 | ✅ 同步 + WAL 透传 | ✅ 编译期推断 | **推荐（升级选项）** |
| TypeORM | ❌ 装饰器冲突 | ❌ 10 依赖 | ✅ 有 enableWAL | ✅ | **不推荐**：装饰器硬伤 |
| Sequelize | v6 可行/v7❌ | ❌ 16 依赖 + moment | ⚠️ sqlite3 异步 | ✅ | **不推荐**：依赖重 + v7 未稳 |
| Kysely | ✅ 完全 | ✅ 0 运行时依赖 | ✅ 但异步包装 | ✅ 手写接口 | 可选，但异步削性能 |
| better-sqlite3 | ✅ 兼容 | ✅ 2 依赖 | ✅✅ 同步 + WAL 一等 | ❌ 无推导 | **推荐（基线）** |

### 推荐结论

**分层推荐，按 schema 复杂度决定：**

1. **schema 简单（≤5 张表，以请求日志/映射表为主）→ better-sqlite3 + 手写 SQL**。
   - 与项目「极简依赖（3 个）」「无构建」哲学完全一致；同步 API 对本地状态持久化天然合适且性能最优（官方基准 2.9–24.4x 优于异步驱动）；WAL/事务/prepared statement 一等支持。
   - 代价：无 schema 类型推导（查询结果需手写泛型或接受 `unknown`）、无内置迁移（用 `PRAGMA user_version` + `db.exec()` 自行实现，约 20 行代码）。
   - 这与 [Express 评估](./express-refactor-evaluation.md) 的结论逻辑一致：**当前规模下不为不需要的复杂度买单**。

2. **schema 开始复杂（多表关联、需要类型安全查询构建与声明式迁移）→ Drizzle ORM（配 better-sqlite3 驱动）**。
   - 0 运行时依赖、编译期类型推断无需 codegen、pure ESM + dual，是唯一同时满足「无构建」「极简依赖」「类型安全」三者的 ORM。
   - 与 better-sqlite3 共享同一底层驱动，**从基线升级到 Drizzle 的迁移路径平滑**（驱动不变，只换查询层）。
   - 注意：稳定版 0.45.2 走 better-sqlite3（native）；若想完全零 native，可切 `1.0.0-rc.4` 用 `node:sqlite`（Node 内置），但 rc 有 breaking change，需评估。

3. **Kysely 作为备选**：若偏好「查询构建器而非 ORM」且不介意异步 API 削弱 better-sqlite3 同步优势，可考虑。但本项目本地状态场景下，同步 API 是 better-sqlite3 的核心价值，异步包装反而抵消了选 better-sqlite3 的理由。

### 明确不推荐

- **Prisma**：125+ MB 体积 + 必须 codegen + WASM 主线程阻塞，与极简依赖哲学**严重冲突**，置信度：高。
- **TypeORM**：默认装饰器与 `--experimental-strip-types` **直接冲突**（Node 官方明确抛解析错误），虽可绕路 `EntitySchema` 但非主线 + 10 个运行时依赖，置信度：高。
- **Sequelize**：v7（未来方向）装饰器硬依赖 transpiler 不兼容；v6 虽可行但 16 个依赖（含 moment）+ `sqlite3` 异步驱动 + 「寻找新维护者」状态，置信度：高。

### 共同的摩擦点：native 模块

所有走 better-sqlite3/sqlite3 的方案都引入 native 模块（`prebuild-install || node-gyp rebuild`）。常见平台（macOS/Linux x64/arm64 + LTS Node）有预编译二进制，零配置；冷门平台或非 LTS Node 需 Python + C++ 工具链。本项目运行于 macOS，`@types/node` ^24 对应 Node 24 在 better-sqlite3 engines 覆盖内（`24.x`），预编译二进制应可用。**若要完全规避 native，唯一路径是 Drizzle rc.4 + `node:sqlite`**（Node 22+ 内置，实验性），但需接受 rc 风险。

---

## 关键不确定性

1. **`--experimental-strip-types` 的官方兼容背书**：除 Node 官方文档明确「不支持装饰器」外，各框架均**未官方声明**支持 type stripping 运行方式。Drizzle/Kysely/better-sqlite3 基于「包为预编译 JS + 用户侧仅类型剥离」机制推断兼容，置信度：中-高（机制层面成立，但缺官方测试背书，建议引入后实测）。
2. **SQLite WAL 的官方支持**：仅 better-sqlite3 与 TypeORM 有明确一手说明（better-sqlite3 一等推荐、TypeORM `enableWAL` 选项）；Drizzle/Kysely/Sequelize/Prisma 均无 WAL 专属文档，只能推断通过原始 SQL `PRAGMA` 透传。
3. **运行时性能基准**：仅 better-sqlite3 有官方基准；其余框架均无官方 SQL 运行时基准（Drizzle 仅有 PG rps 声明，Kysely 仅有 TS 编译基准）。性能对比多基于「底层驱动同步/异步」机制推断。
4. **Drizzle `node:sqlite` 路线**：稳定版 0.45.2 不含 `node-sqlite` 导出，零 native 路线须切 `1.0.0-rc.4`（有 breaking change：RQBv1 移除、casing API 重做）；`node:sqlite` 在 Node 24 的 stable/experimental 标记未核实。
5. **better-sqlite3 npm 落后 GitHub**：npm `latest` 12.11.1 落后 GitHub `v12.12.0`（2026-07-15）一个月，未找到未发布原因的官方说明。

---

## 参考来源列表（一手为主）

### Prisma
- npm registry prisma：https://registry.npmjs.org/prisma
- npm registry @prisma/client：https://registry.npmjs.org/@prisma/client
- GitHub Releases：https://github.com/prisma/prisma/releases
- 官方 Generators 文档：https://www.prisma.io/docs/orm/prisma-schema/overview/generators
- 官方 Prisma Migrate 文档：https://www.prisma.io/docs/orm/prisma-migrate/workflows/development-and-production
- 官方 SQLite database connector：https://www.prisma.io/docs/orm/overview/databases/sqlite
- 官方 Generating Prisma Client：https://www.prisma.io/docs/orm/prisma-client/setup-and-configuration/generating-prisma-client

### Drizzle ORM
- npm registry drizzle-orm：https://registry.npmjs.org/drizzle-orm
- npm registry drizzle-kit：https://registry.npmjs.org/drizzle-kit
- GitHub 仓库：https://github.com/drizzle-team/drizzle-orm
- GitHub Releases：https://github.com/drizzle-team/drizzle-orm/releases
- 官方 get-started-sqlite：https://orm.drizzle.team/docs/get-started-sqlite
- 官方 migrations 文档：https://orm.drizzle.team/docs/migrations
- 官方 performance 文档：https://orm.drizzle.team/docs/performance
- better-sqlite3 driver 源码：https://github.com/drizzle-team/drizzle-orm/blob/main/drizzle-orm/src/better-sqlite3/driver.ts

### TypeORM
- npm registry typeorm：https://www.npmjs.com/package/typeorm
- GitHub 仓库：https://github.com/typeorm/typeorm
- GitHub Releases：https://github.com/typeorm/typeorm/releases
- package.json：https://raw.githubusercontent.com/typeorm/typeorm/master/package.json
- 官方 SQLite 文档：https://typeorm.io/docs/drivers/sqlite
- EntitySchema 文档：https://raw.githubusercontent.com/typeorm/typeorm/master/docs/docs/entity/6-separating-entity-definition.md
- migrations setup：https://raw.githubusercontent.com/typeorm/typeorm/master/docs/docs/migrations/02-setup.md
- using-cli：https://raw.githubusercontent.com/typeorm/typeorm/master/docs/docs/using-cli.md

### Sequelize
- npm registry sequelize：https://registry.npmjs.org/sequelize
- GitHub 仓库：https://github.com/sequelize/sequelize
- GitHub Releases：https://github.com/sequelize/sequelize/releases
- v6 TS 文档：https://sequelize.org/docs/v6/other-topics/typescript/
- v6 migrations：https://sequelize.org/docs/v6/other-topics/migrations/
- v6 dialect-specific：https://sequelize.org/docs/v6/other-topics/dialect-specific-things/
- v7 defining-models：https://sequelize.org/docs/v7/models/defining-models/
- v7 SQLite：https://sequelize.org/docs/v7/databases/sqlite/
- npm sqlite3：https://registry.npmjs.org/sqlite3/latest

### Kysely
- npm registry kysely：https://registry.npmjs.org/kysely
- GitHub 仓库：https://github.com/kysely-org/kysely
- GitHub Releases：https://github.com/kysely-org/kysely/releases
- 官方 getting-started：https://kysely.dev/docs/getting-started
- 官方 dialects：https://kysely.dev/docs/dialects
- 官方 migrations：https://kysely.dev/docs/migrations
- 官方 generating-types：https://kysely.dev/docs/generating-types
- SqliteDialect API：https://kysely-org.github.io/kysely-apidoc/classes/SqliteDialect.html

### better-sqlite3
- npm registry latest：https://registry.npmjs.org/better-sqlite3/latest
- GitHub 仓库：https://github.com/WiseLibs/better-sqlite3
- GitHub Releases：https://github.com/WiseLibs/better-sqlite3/releases
- README：https://github.com/WiseLibs/better-sqlite3/blob/master/README.md
- API 文档：https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md
- performance 文档：https://github.com/WiseLibs/better-sqlite3/blob/master/docs/performance.md
- benchmark 文档：https://github.com/WiseLibs/better-sqlite3/blob/master/docs/benchmark.md
- @types/better-sqlite3：https://github.com/DefinitelyTyped/DefinitelyTyped/blob/master/types/better-sqlite3/index.d.ts

### Node.js（类型剥离/装饰器限制）
- Node.js TypeScript 官方文档：https://nodejs.org/api/typescript.html

### 项目内相关
- Express 重构评估（结论逻辑参照）：./express-refactor-evaluation.md

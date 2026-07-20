# Commit 历史中文化

master 的全部非 merge commit 消息改写为「英文 conventional 前缀 + 中文正文」：英文消息翻译成中文，已有中文消息规范化补齐前缀，11 个 merge commit 原样保留，`(#PR)` 编号保留，术语沿用 CONTEXT.md 既有词汇。改写用 git filter-repo 按预先审定的映射表执行，仅动 commit message，全部 88 个 commit 的 tree hash 逐一比对不变。

这是一次不可逆的已发布历史改写：所有 commit hash 变更，旧 hash 永久失效，必须 force push 覆盖 origin/master，并删除已合并的旧分支。消息中引用旧 hash 的地方（`28f17f0` 引用 `b7ecdf5`）在第二遍改写中替换为新 hash，保住可追溯性。GitHub 的 PR 页面经 `refs/pull/*` 仍保留旧英文 commit 记录，删分支不丢审查痕迹。

代价是历史追溯需要跨越 hash 断层；换来的是历史语言与仓库文档（CONTEXT.md、ADR 均为中文正文）一致。改写前的完整历史备份在 `/tmp/commit-zh/pre-rewrite-backup.bundle`（全 ref bundle，不留仓库）。

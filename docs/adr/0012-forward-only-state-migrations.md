# State Store 仅前向自动迁移

Production CLI 启动时自动执行 State Store 的前向 SQLite schema 迁移，不提供回滚迁移或自动备份。升级前的数据库备份由部署方负责；此策略保持 `start` 为唯一运维入口并沿用现有状态库初始化行为。

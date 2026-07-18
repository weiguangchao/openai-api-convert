# 30 秒优雅退出

Production CLI 收到 `SIGTERM` 或 `SIGINT` 后停止接收新连接，最多等待 30 秒完成在途请求，再关闭 State Store 与日志。超过窗口仍未结束的请求由进程退出终止；重启和强制杀进程仍由外部 Service Supervisor 决定。

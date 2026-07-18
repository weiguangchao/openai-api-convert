# 回环监听

Production CLI 固定监听 `127.0.0.1`，未配置端口时使用 `8417`，不提供绑定任意网卡的配置。反向代理只公开 `/v1/responses`；未认证 `/healthz` 仅供本机探针，`/readyz` 与 `/metrics` 保持 Bridge Authentication。需要外部访问时，由部署方的反向代理终止并转发流量；这延续既有安全默认值，避免 Bridge 因配置错误直接暴露公网。

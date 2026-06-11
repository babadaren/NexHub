# Proxy Control Center

极简代理节点控制台。项目根据 `proxy_control_center_full_design_dev_spec.md` 和 `wireframes/` 设计图实现。

## 本地开发

```bash
pnpm install
pnpm dev
```

- 前端：http://localhost:5173
- 后端：http://localhost:8080
- 默认管理员：admin
- 默认密码：启动时自动生成并打印到后端日志；开发环境也可设置 `ADMIN_PASSWORD`。

## 目录

```text
backend/   Fastify API 服务
frontend/  React + Vite 管理台
deploy/    Docker Compose 和部署脚本
wireframes/设计图
```

当前版本优先完成可运行纵向切片，代理核心、PostgreSQL、Redis 已在配置和接口层预留，开发模式使用本地 JSON 存储。

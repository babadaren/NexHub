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

开发模式默认使用本地 JSON 存储，便于不依赖 PostgreSQL/Redis 直接启动。

## Docker 部署

```bash
cd deploy
cp .env.example .env
./install.sh
docker compose up -d
```

`docker-compose.local.yml` 默认使用 PostgreSQL 和 Redis：

- `STORAGE_DRIVER=postgres` 时启动自动执行 `backend/migrations/*.sql`。
- `REDIS_URL` 可用于实时节点状态和事件流。
- `ENGINE_MODE=render-only` 只生成 sing-box 配置；改为 `managed` 且 `ENGINE_BINARY` 可执行时，会执行 `sing-box check`、启动和重载核心进程。
- 订阅导入支持分享链接、base64 订阅、Clash YAML 和 Sing-box JSON；远端 URL 默认禁止访问内网/本机地址。
- 协议适配器覆盖 HTTP、SOCKS5、Shadowsocks、VMess、VLESS、Trojan、WireGuard、Hysteria2、TUIC、SSH Tunnel 的解析、校验和 sing-box 配置渲染骨架。
- 应用数据目录是 `deploy/data/`，数据库目录是 `deploy/postgres_data/`。
- 后台“备份数据”会在 `data/backups/` 生成 JSON 备份，包含当前应用状态、订阅源和代理核心配置快照；文件含凭据，请按敏感文件保管。
- 系统设置页支持从最近备份恢复，恢复前会自动创建一份 `before-restore` 备份，便于误操作回退。
- 本地节点分享使用独立 token，公开订阅路径为 `/sub/:token`；轮换分享链接后旧 token 立即失效。

## 验证

```bash
pnpm build
pnpm test:adapters
pnpm smoke
pnpm smoke:engine
```

如果有可用 PostgreSQL，可以额外运行：

```bash
POSTGRES_SMOKE_URL=postgres://user:password@localhost:5432/proxy_panel pnpm smoke:postgres
```

## 目录

```text
backend/    Fastify API 服务
frontend/   React + Vite 管理台
deploy/     Docker Compose 和部署脚本
scripts/    smoke 测试脚本
wireframes/ 设计图
```

当前版本已实现可运行纵向切片、PostgreSQL/Redis 可选运行结构、sing-box 配置生成、`current.json` / `previous.json` 回滚文件骨架、可选的 sing-box 进程管理、订阅源保存/手动刷新/导入去重、应用级 JSON 备份和恢复、本地节点分享 token 轮换，以及主要协议适配器骨架。PostgreSQL `pg_dump`/`pg_restore` 级恢复和协议级真实连通性测试仍在后续开发范围内。

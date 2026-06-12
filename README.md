# Proxy Control Center

极简代理节点控制台。项目根据 `proxy_control_center_full_design_dev_spec.md` 和 `wireframes/` 设计图实现。

当前发布说明见 `RELEASE_NOTES.md`。生产式部署应固定不可变镜像标签，例如 `IMAGE_TAG=v0.1.0`；`latest` 只用于本地试用。

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

版本化安装包应从同一个发布标签获取 `install.sh`、Compose、`.env.example` 和部署 README，例如：

```bash
curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/v0.1.0/deploy/install.sh -o install.sh
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

完整串行验收可执行：

```bash
pnpm smoke:all -- --list
pnpm smoke:all
pnpm smoke:all -- --require-postgres
pnpm smoke:all -- --require-postgres --require-compose
```

真实 PostgreSQL smoke 会在未提供连接串且 Docker 可用时自动启动临时 PostgreSQL；本地 Docker 不可用时会跳过，CI 或正式验收可设置 `POSTGRES_SMOKE_REQUIRED=true` 让缺失真实 PG 直接失败。如果要使用已有数据库，可以显式传入连接串：

```bash
pnpm smoke:postgres
POSTGRES_SMOKE_REQUIRED=true pnpm smoke:postgres
POSTGRES_SMOKE_URL=postgres://user:password@localhost:5432/proxy_panel pnpm smoke:postgres
```

Docker Compose 启动验收可以单独执行。脚本会使用临时目录、随机宿主机端口和独立 project name，验证镜像构建、app/PostgreSQL/Redis 启动、`/health`、`/ready`、首次随机密码日志和清理流程：

```bash
pnpm smoke:compose
pnpm smoke:compose-required
COMPOSE_SMOKE_REQUIRED=true pnpm smoke:compose
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

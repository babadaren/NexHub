# Proxy Control Center 部署说明

生产部署推荐 Linux + Docker Compose。Windows 只建议用于 Docker Desktop 试用，不承诺一键脚本。

本文档适配镜像标签 `v0.1.0`，要求 Docker Compose v2。生产部署请固定 `IMAGE_TAG=v0.1.0`；`latest` 只用于本地试用。

版本化安装示例：

```bash
curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/v0.1.0/deploy/install.sh -o install.sh
```

## 1. 准备目录

```bash
cd deploy
chmod +x install.sh
./install.sh
```

脚本会创建：

- `.env`
- `docker-compose.yml`
- `data/`
- `postgres_data/`
- `redis_data/`

已存在 `.env` 时不会覆盖用户已有值，只会补齐空的 `POSTGRES_PASSWORD`、`JWT_SECRET`、`CONFIG_ENCRYPTION_KEY`。

`install.sh` 默认会把 `docker-compose.local.yml` 安装为 `docker-compose.yml`，作为推荐的 PostgreSQL + Redis + 本地目录部署方式。当前目录已经存在 `.env`、`docker-compose.yml`、`data/`、`postgres_data/` 或 `redis_data/` 时会先要求确认；已有 `docker-compose.yml` 会备份为 `docker-compose.yml.bak.*` 后再安装默认模板。确实需要保留自定义 compose 时可执行：

```bash
PCC_INSTALL_KEEP_COMPOSE=true ./install.sh
```

`SERVER_MODE=release` 会强制要求 `JWT_SECRET` 和 `CONFIG_ENCRYPTION_KEY` 为非空随机值。手动维护 `.env` 时可用以下命令生成：

```bash
openssl rand -hex 32
```

如果管理后台固定通过反向代理域名访问，可以设置：

```env
PUBLIC_BASE_URL=https://panel.example.com
```

设置后，本地节点分享订阅链接和未显式配置公网 host 的单节点 URI 会优先使用该地址；未设置时继续从 `X-Forwarded-Proto`、`X-Forwarded-Host` 或当前请求 Host 推断。

## 2. 启动

```bash
docker compose up -d
docker compose ps
```

健康检查：

```bash
curl http://127.0.0.1:8080/health
curl http://127.0.0.1:8080/ready
```

如果 `.env` 中 `ADMIN_PASSWORD` 为空，首次随机管理员密码只会在启动日志中出现一次：

```bash
docker compose logs app | grep -i admin
```

## 3. 常用命令

查看日志：

```bash
docker compose logs -f app
docker compose logs -f postgres
docker compose logs -f redis
```

查看应用内部状态：

```bash
docker compose exec app proxy-control-center system status
```

修改 `.env` 后重启：

```bash
docker compose up -d
```

停止：

```bash
docker compose down
```

## 4. 端口策略

默认 `docker-compose.local.yml` 使用 Docker bridge 网络。容器启动后不能动态新增宿主机端口映射，所以本地节点只能启用 `.env` 中已经映射的端口段：

```env
LOCAL_TCP_PORT_RANGE=20000-20100
LOCAL_UDP_PORT_RANGE=20000-20100
```

如果页面提示端口没有映射到 Docker 宿主机：

1. 把本地节点端口改到上述范围内。
2. 或修改 `.env` 里的端口段后执行 `docker compose up -d`。
3. 或在 Linux 上改用 `docker-compose.host.yml`，让应用使用 host network。

host network 版本只给高级用户使用：

```bash
cp docker-compose.host.yml docker-compose.yml
docker compose up -d
```

`docker-compose.host.yml` 会把 Redis 绑定到宿主机 `127.0.0.1:6379`，因此 `REDIS_PASSWORD` 不能为空；为空时 Redis 容器会直接退出并提示补齐密码。
该模板会设置 `NETWORK_MODE=host`，系统设置页会显示“高级网络模式已开启”提示。

## 5. 反向代理

管理后台建议只监听 `127.0.0.1:8080`，公网访问通过 Caddy 或 Nginx 提供 HTTPS。

Caddy 示例见 `Caddyfile.example`。代理必须转发：

- `X-Forwarded-Proto`
- `X-Forwarded-Host`

不要把管理后台域名当作本地节点分享域名。

## 6. 备份和迁移

整目录冷备：

```bash
docker compose down
cd ..
tar czf proxy-control-center-backup.tar.gz deploy/
```

恢复：

```bash
tar xzf proxy-control-center-backup.tar.gz
cd deploy
docker compose up -d
```

后台“备份数据”按钮会在 `data/backups/` 生成 JSON 备份。备份包含节点凭据和密钥摘要，请按敏感文件保管。

恢复后检查：

```bash
curl http://127.0.0.1:8080/ready
docker compose logs app --tail 100
```

## 7. 升级和回滚

升级前先备份：

```bash
docker compose exec app proxy-control-center backup create --reason before-update
sed -i 's/^IMAGE_TAG=.*/IMAGE_TAG=v0.1.0/' .env
docker compose pull
docker compose up -d
curl http://127.0.0.1:8080/ready
```

如果升级失败：

1. 把 `.env` 中 `IMAGE_TAG` 改回上一版本。
2. 执行 `docker compose up -d`。
3. 如数据库已迁移且无法启动，用升级前备份恢复。

## 8. Redis 暴露风险

默认本地目录版 Redis 只在 Docker 内部网络使用，不映射到宿主机。只有在明确映射 Redis 到宿主机时，必须设置：

```env
REDIS_PASSWORD=<strong-password>
```

如果设置 `REDIS_REQUIRED=true`，必须同时提供可连接的 `REDIS_URL`。Redis 不可连接时应用会启动失败，并在 app 日志中提示检查 `REDIS_URL`、`REDIS_REQUIRED` 和 Redis 服务状态。

## 9. migration checksum 失败

出现 migration checksum 错误时，不要手动改数据库表。正确处理：

1. 停止服务。
2. 恢复升级前备份。
3. 使用修正后的版本重新升级。

## 10. 数据目录

- `data/`：应用状态、代理核心配置、备份文件。
- `postgres_data/`：PostgreSQL 数据。
- `redis_data/`：Redis AOF/RDB。

迁移机器时这三个目录和 `.env` 必须一起迁移。

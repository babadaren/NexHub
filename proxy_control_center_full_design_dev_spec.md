# Proxy Control Center 极简代理节点控制台 - 产品设计文档

版本：v1.0  
定位：给没有网络运维能力的用户使用的“傻瓜式节点配置与监控面板”。  
核心任务只有两个：

1. **配置远端节点**：本机连接到其他地方的代理节点。
2. **创建本地节点**：把本机开放成节点，给手机、电脑、异地设备或其他人连接。

本产品不做复杂的多租户、不做角色权限、不做企业级审批流。系统只有一个管理员账号，所有设计都围绕“少填字段、自动识别、一键测试、能看懂错误、保存后直接可用”。

---

## 1. 设计原则

### 1.1 两个入口，不让用户理解复杂概念

用户进入系统后只看到两个主要入口：

- **添加远端节点**：我想连接别人的节点。
- **创建本地节点**：我想让别人连接我的本机。

避免使用“入站 / 出站 / 路由链 / outbound / inbound”等专业词作为一级入口。专业词只出现在高级参数、开发文档或配置预览中。

### 1.2 向导式配置

每个节点配置都按 4 步完成：

```text
选择用途或协议 → 填写必要信息 → 一键测试 → 保存或分享
```

### 1.3 高级字段默认折叠

普通用户只看到：名称、协议、地址、端口、密码/UUID、开放范围。高级参数如 Reality、WS Path、gRPC ServiceName、Fingerprint、MTU、AllowedIPs 默认折叠。

### 1.4 所有保存前必须测试

节点保存前，系统必须自动测试：格式、连接、认证、DNS、TLS、延迟。测试失败不阻止用户保存草稿，但默认不启用。

### 1.5 错误提示必须“人话化”

不要显示：`dial tcp i/o timeout`。  
要显示：`服务器连接超时：请检查地址、端口或防火墙。`

### 1.6 数据保留克制

秒级实时监控只放 Redis，设置 TTL 自动清理。PostgreSQL 只保存账号、节点配置、测试摘要、每日/每小时聚合摘要、审计记录，避免监控数据长期占满磁盘。

---

## 2. 信息架构

左侧导航保留 6 个一级入口：

```text
总览
远端节点
本地节点
实时监控
历史摘要
系统设置
```

不再设计“用户管理、权限管理、组织管理、审批中心”等模块。

---

## 3. 核心用户流程

### 3.1 添加远端节点流程

```text
点击“添加远端节点”
→ 粘贴分享链接或选择协议
→ 系统自动识别协议类型
→ 只填写缺失字段
→ 一键测试
→ 通过后保存并启用
```

### 3.2 创建本地节点流程

```text
点击“创建本地节点”
→ 选择用途：仅本机 / 局域网 / 公网 / 中继
→ 系统推荐协议和端口
→ 自动生成密码或 UUID
→ 检测本机可达性
→ 创建并测试
→ 生成二维码、订阅链接或客户端配置
```

### 3.3 节点日常维护流程

```text
总览发现异常
→ 点击节点详情
→ 一键测试
→ 系统指出原因
→ 用户按建议修改
→ 再次测试
→ 保存
```

---

## 4. 支持的节点类型

### 4.1 远端节点类型

| 类型 | 用户必填字段 | 高级字段 | 适合人群 |
|---|---|---|---|
| 智能识别 | 分享链接 / 订阅 URL | 无 | 新手优先 |
| HTTP | 地址、端口、账号密码可选 | Header | 简单代理 |
| SOCKS5 | 地址、端口、账号密码可选 | UDP 开关 | 通用代理 |
| Shadowsocks | 地址、端口、加密方式、密码 | 插件、UDP | 轻量节点 |
| VMess | 地址、端口、UUID | 传输、TLS、SNI | 兼容旧配置 |
| VLESS | 地址、端口、UUID | Reality、TLS、WS、gRPC、Flow | 常用新配置 |
| Trojan | 地址、端口、密码 | TLS、SNI、ALPN | TLS 节点 |
| WireGuard | Endpoint、密钥、Address | MTU、DNS、AllowedIPs | 组网场景 |
| Hysteria2 | 地址、端口、密码 | obfs、SNI、insecure | UDP 场景 |
| TUIC | 地址、端口、UUID、密码 | 拥塞控制、SNI | 高级场景 |
| SSH Tunnel | 主机、端口、用户名、密钥/密码 | 本地转发规则 | 技术用户 |

### 4.2 本地节点类型

| 类型 | 用户必填字段 | 系统自动生成 | 用途 |
|---|---|---|---|
| HTTP | 监听范围、端口 | 账号密码可选 | 本机/局域网简单使用 |
| SOCKS5 | 监听范围、端口 | 账号密码可选 | 通用本地代理 |
| Shadowsocks | 监听范围、端口 | 密码、加密方式 | 给其他设备连接 |
| VLESS | 域名/地址、端口 | UUID、TLS 建议 | 公网节点 |
| Trojan | 域名/地址、端口 | 密码、TLS 建议 | 公网节点 |
| WireGuard | 监听端口、网段 | 密钥、客户端配置 | 私有组网 |
| Hysteria2 | 监听端口、密码 | obfs 可选 | UDP 场景 |

---

## 5. 页面设计图总览


### 系统架构与数据流

![系统架构与数据流](wireframes/diagram_01_architecture_storage.png)


### 页面 01 - 首次安装完成

![页面 01 - 首次安装完成](wireframes/page_01_install_complete.png)


### 页面 02 - 管理员登录

![页面 02 - 管理员登录](wireframes/page_02_login.png)


### 页面 03 - 总览

![页面 03 - 总览](wireframes/page_03_dashboard.png)


### 页面 04 - 远端节点列表

![页面 04 - 远端节点列表](wireframes/page_04_remote_nodes.png)


### 页面 05 - 添加远端节点向导

![页面 05 - 添加远端节点向导](wireframes/page_05_remote_wizard.png)


### 页面 06 - 本地节点列表

![页面 06 - 本地节点列表](wireframes/page_06_local_nodes.png)


### 页面 07 - 创建本地节点向导

![页面 07 - 创建本地节点向导](wireframes/page_07_local_wizard.png)


### 页面 08 - 节点详情与一键测试

![页面 08 - 节点详情与一键测试](wireframes/page_08_node_detail.png)


### 页面 09 - 实时监控

![页面 09 - 实时监控](wireframes/page_09_realtime_monitor.png)


### 页面 10 - 系统设置

![页面 10 - 系统设置](wireframes/page_10_settings.png)


---

## 6. 页面详细说明

### 6.1 首次安装完成页

**目标**：告诉用户系统已经可以使用，管理员账号已自动创建，不需要手动添加用户。  
**核心操作**：进入登录页、复制查看密码命令。  
**用户提示**：如果 ADMIN_PASSWORD 未设置，管理员密码会在容器日志中显示。

### 6.2 登录页

**目标**：只做管理员登录，不提供注册入口。  
**表单字段**：管理员账号/邮箱、密码。  
**异常状态**：密码错误、服务未初始化、数据库连接异常。

### 6.3 总览页

**目标**：让用户知道系统当前是否可用，并提供两个最重要按钮：添加远端节点、创建本地节点。  
**核心指标**：远端在线、本地节点、接入客户端、实时入站、实时出站、平均延迟。  
**设计重点**：总览页不是复杂运维大屏，而是“下一步入口”。

### 6.4 远端节点列表

**目标**：管理本机要连接出去的节点。  
**核心操作**：添加远端节点、导入订阅/链接、一键测试、编辑、删除。  
**列表字段**：名称、类型、地址、状态、延迟、今日流量、操作。

### 6.5 添加远端节点向导

**目标**：不懂协议的人也能添加节点。  
**核心交互**：默认推荐“智能识别”，用户粘贴链接即可。  
**手动模式**：选择协议后，只显示该协议必填字段。  
**保存规则**：测试通过后保存并启用；测试失败时可保存草稿但不启用。

### 6.6 本地节点列表

**目标**：管理别人连接本机的入口。  
**核心操作**：创建本地节点、公网检测、分享、生成订阅、停止/重启。  
**列表字段**：名称、协议、监听地址、开放范围、接入客户端、状态、操作。

### 6.7 创建本地节点向导

**目标**：用户选择“我要给谁用”，系统自动转换成监听地址、端口、认证方式。  
**用途选项**：仅本机软件用、给局域网设备用、给外地设备连接、作为中继入口。  
**默认策略**：公网用途默认推荐 443 端口和强认证；局域网用途默认限制私网地址。

### 6.8 节点详情与一键测试页

**目标**：把状态、测试、分享、重启、停止集中在同一个页面。  
**测试结果**：必须以“通过 / 警告 / 失败 + 说明 + 建议”展示。  
**客户端列表**：只显示必要信息，来源 IP 默认脱敏。

### 6.9 实时监控页

**目标**：展示实时速率、延迟、连接数和短期事件。  
**数据来源**：Redis。  
**保留策略**：秒级数据默认保留 6 小时，可配置到 24 小时；PostgreSQL 只存聚合摘要。

### 6.10 系统设置页

**目标**：只保留管理员账号、部署状态、数据保留策略、备份和更新。  
**不做**：用户管理、角色权限、复杂审计审批。

---

## 7. 弹窗设计图总览


### 弹窗 01 - 导入远端节点

![弹窗 01 - 导入远端节点](wireframes/modal_01_import_remote.png)


### 弹窗 02 - 一键测试结果

![弹窗 02 - 一键测试结果](wireframes/modal_02_test_result.png)


### 弹窗 03 - 分享本地节点

![弹窗 03 - 分享本地节点](wireframes/modal_03_share_local_node.png)


### 弹窗 04 - 公网可达性检测

![弹窗 04 - 公网可达性检测](wireframes/modal_04_public_check.png)


### 弹窗 05 - 高级参数

![弹窗 05 - 高级参数](wireframes/modal_05_advanced_params.png)


### 弹窗 06 - 停止节点确认

![弹窗 06 - 停止节点确认](wireframes/modal_06_confirm_stop.png)


### 弹窗 07 - 修改管理员密码

![弹窗 07 - 修改管理员密码](wireframes/modal_07_change_password.png)


### 弹窗 08 - 保存成功

![弹窗 08 - 保存成功](wireframes/modal_08_saved_success.png)


---

## 8. 弹窗详细说明

### 8.1 导入远端节点弹窗

触发：远端节点页点击“导入订阅/链接”。  
功能：粘贴 vmess/vless/trojan/ss 链接、订阅 URL、Clash/Sing-box 配置片段。  
结果：解析出节点列表，用户勾选后导入。

### 8.2 一键测试结果弹窗

触发：远端节点或本地节点点击“一键测试”。  
展示：格式校验、连接测试、认证测试、DNS、TLS、测速、最终判断。  
交互：通过则保存；警告允许保存；失败默认只保存草稿。

### 8.3 分享本地节点弹窗

触发：本地节点点击“分享”。  
展示：分享链接、二维码、Clash 配置、Sing-box 配置、WireGuard 配置文件、订阅链接。  
安全：提示链接包含凭据，只发给可信设备。

### 8.4 公网可达性检测弹窗

触发：本地节点创建或列表页点击“公网检测”。  
检测：公网 IP、DNS、端口、IPv6、NAT 类型、防火墙建议。  
输出：必须告诉用户怎么修，例如“改用 443”或“路由器做端口转发”。

### 8.5 高级参数弹窗

触发：向导中点击“高级参数”。  
原则：默认不打开，不让新手被参数吓到。  
内容：传输方式、TLS SNI、WS Path、Reality、Fingerprint、UDP 等。

### 8.6 停止节点确认弹窗

触发：节点详情点击“停止”。  
规则：显示当前接入客户端数量，要求输入 STOP 后再停止。

### 8.7 修改管理员密码弹窗

触发：系统设置页点击“修改密码”。  
规则：只有一个管理员账号，修改后提示保存好密码。

### 8.8 保存成功弹窗

触发：创建/编辑节点保存成功。  
下一步：查看详情、分享二维码、继续创建。

---

## 9. 空状态设计

### 9.1 没有远端节点

标题：还没有远端节点  
说明：添加一个远端节点后，本机就可以连接出去。  
按钮：添加远端节点、导入分享链接。

### 9.2 没有本地节点

标题：还没有本地节点  
说明：创建本地节点后，手机或异地设备就可以连接本机。  
按钮：创建本地节点、公网检测说明。

### 9.3 Redis 暂无实时数据

标题：正在等待监控数据  
说明：节点启动后需要几秒钟产生实时数据。  
按钮：刷新、查看服务日志。

---

## 10. 文案规范

| 技术错误 | 用户看到的文案 |
|---|---|
| dial tcp timeout | 服务器连接超时，请检查地址、端口或防火墙。 |
| auth failed | 认证失败，请检查密码、UUID 或密钥。 |
| tls handshake failed | TLS 握手失败，请检查 SNI、证书或 Reality 参数。 |
| connection refused | 目标端口没有服务，请检查节点是否启动。 |
| invalid config | 配置格式不正确，请检查红色标记字段。 |

---

## 11. MVP 范围

第一版只做这些：

- 单管理员登录。
- Docker Compose 一键部署。
- 自动初始化 PostgreSQL、Redis、管理员账号。
- 远端节点添加、导入、测试、保存、编辑、删除。
- 本地节点创建、测试、分享、停止、删除。
- 实时监控使用 Redis。
- PostgreSQL 保存配置、测试摘要、每日流量摘要。
- 系统设置：修改密码、备份、更新、数据保留策略。

暂不做：多用户、权限、审批、多租户、复杂账单、完整包内容保存。


---

# Proxy Control Center - 开发说明文档

版本：v1.0  
架构目标：轻量、一键部署、单管理员、PostgreSQL + Redis、配置向导优先。

---

## 1. 技术选型建议

### 1.1 推荐栈

| 层 | 推荐 | 说明 |
|---|---|---|
| 前端 | Vue 3 + TypeScript + Vite 或 React + TypeScript | 管理台页面简单，二者都可 |
| 后端 | Go + Gin/Fiber 或 Node.js + Fastify/NestJS | 推荐 Go，便于单二进制和内嵌前端 |
| 数据库 | PostgreSQL 15+ | 长期配置和账号数据 |
| 缓存/实时数据 | Redis 7+ | 实时监控、在线状态、短期事件流 |
| 部署 | Docker Compose | 一键部署，附带 PostgreSQL 和 Redis |
| 代理核心 | 适配层方式 | MVP 可先支持 sing-box，再扩展 xray 等 |

### 1.2 推荐项目结构

```text
proxy-control-center/
├── backend/
│   ├── cmd/server/
│   ├── internal/
│   │   ├── auth/              # 单管理员登录
│   │   ├── nodes/             # 远端/本地节点业务
│   │   ├── adapters/          # 协议适配器
│   │   ├── engine/            # 代理核心配置生成与热加载
│   │   ├── metrics/           # Redis 实时监控
│   │   ├── setup/             # AUTO_SETUP 自动初始化
│   │   ├── storage/           # PostgreSQL/Redis 客户端
│   │   └── system/            # 备份、更新、健康检查
│   ├── migrations/
│   └── web/                   # 可内嵌前端 dist
├── frontend/
│   ├── src/pages/
│   ├── src/components/
│   ├── src/api/
│   └── src/stores/
├── deploy/
│   ├── docker-compose.yml
│   ├── .env.example
│   └── install.sh
└── docs/
```

---

## 2. 总体架构

![系统架构与数据流](wireframes/diagram_01_architecture_storage.png)

### 2.1 数据流

```text
前端页面
  → 后端 API
    → PostgreSQL：管理员、节点配置、测试摘要、每日摘要
    → Redis：实时速率、延迟、在线客户端、短期事件流
    → 代理核心适配层：生成 inbound/outbound 配置并热加载
```

### 2.2 为什么这样存储

- PostgreSQL 不适合持续写入秒级监控点，否则磁盘增长快、索引膨胀、查询成本高。
- Redis 适合保存“当前状态”和“短窗口曲线”，用 TTL 或 MAXLEN 自动控制大小。
- 需要历史时，只把小时/天级摘要写回 PostgreSQL。

---

## 3. 自动初始化设计

### 3.1 启动顺序

当 `AUTO_SETUP=true` 时，后端启动时执行：

```text
1. 读取环境变量
2. 连接 PostgreSQL
3. 连接 Redis
4. 执行 migrations，写入 schema_migrations
5. 如果没有管理员账号，则创建唯一管理员
6. 如果 ADMIN_PASSWORD 未设置，则生成随机密码并打印到日志
7. 初始化默认系统设置
8. 启动 HTTP 服务
```

### 3.2 单管理员规则

数据库可以有 `admins` 表，但业务层必须保证只有一条有效管理员记录。

- 不做用户管理页面。
- 不做 RBAC 权限表。
- 不做邀请注册。
- 不做团队空间。

### 3.3 自动密码策略

```text
如果 ADMIN_USERNAME 和 ADMIN_PASSWORD 都设置：使用环境变量创建管理员。
如果 ADMIN_PASSWORD 未设置：生成 16-24 位随机密码，启动日志打印一次。
首次登录后，提示用户修改密码。
```

日志示例：

```text
[setup] admin account created
[setup] username: admin
[setup] admin password: 9F3m-2Kq8-Wx7p-1Ld0
```

---

## 4. PostgreSQL 数据库设计

### 4.1 表清单

| 表 | 用途 |
|---|---|
| schema_migrations | 迁移记录 |
| admins | 唯一管理员账号 |
| node_configs | 节点配置主表，包含远端/本地 |
| node_config_versions | 节点配置版本 |
| node_test_results | 一键测试摘要 |
| daily_traffic_summaries | 每日流量摘要 |
| audit_logs | 操作审计摘要 |
| system_settings | 系统设置 |

### 4.2 DDL 草案

```sql
CREATE TABLE schema_migrations (
  version TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE admins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL UNIQUE,
  email TEXT,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

CREATE TYPE node_direction AS ENUM ('remote', 'local');
CREATE TYPE node_status AS ENUM ('draft', 'enabled', 'disabled', 'error');

CREATE TABLE node_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  direction node_direction NOT NULL,
  name TEXT NOT NULL,
  protocol TEXT NOT NULL,
  status node_status NOT NULL DEFAULT 'draft',
  enabled BOOLEAN NOT NULL DEFAULT false,
  config JSONB NOT NULL,
  safe_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_test_status TEXT,
  last_test_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_node_configs_direction ON node_configs(direction);
CREATE INDEX idx_node_configs_protocol ON node_configs(protocol);
CREATE INDEX idx_node_configs_updated_at ON node_configs(updated_at DESC);

CREATE TABLE node_config_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id UUID NOT NULL REFERENCES node_configs(id) ON DELETE CASCADE,
  version INT NOT NULL,
  config JSONB NOT NULL,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(node_id, version)
);

CREATE TABLE node_test_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id UUID REFERENCES node_configs(id) ON DELETE SET NULL,
  direction node_direction NOT NULL,
  test_type TEXT NOT NULL,
  final_status TEXT NOT NULL,
  latency_ms INT,
  download_mbps NUMERIC(12, 2),
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  human_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_node_test_results_node_time ON node_test_results(node_id, created_at DESC);

CREATE TABLE daily_traffic_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  day DATE NOT NULL,
  node_id UUID REFERENCES node_configs(id) ON DELETE CASCADE,
  direction node_direction NOT NULL,
  upload_bytes BIGINT NOT NULL DEFAULT 0,
  download_bytes BIGINT NOT NULL DEFAULT 0,
  max_latency_ms INT,
  avg_latency_ms INT,
  error_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(day, node_id)
);

CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id UUID,
  summary TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE system_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 4.3 config JSONB 建议结构

远端节点：

```json
{
  "protocol": "vless",
  "server": "hk.example.com",
  "port": 443,
  "credential": {
    "uuid": "*** encrypted ***"
  },
  "transport": {
    "type": "tcp",
    "tls": true,
    "sni": "hk.example.com"
  },
  "advanced": {}
}
```

本地节点：

```json
{
  "protocol": "vless",
  "listen_host": "0.0.0.0",
  "listen_port": 443,
  "exposure": "public",
  "auth": {
    "type": "uuid",
    "uuid": "*** encrypted ***"
  },
  "route_mode": "direct",
  "forward_to_node_id": null,
  "share": {
    "public_host": "proxy.example.com",
    "subscription_enabled": true
  }
}
```

敏感字段必须加密后存储，前端只展示脱敏值。

---

## 5. Redis 实时数据设计

### 5.1 Key 命名

| Key | 类型 | TTL | 用途 |
|---|---|---|---|
| `rt:global:now` | HASH | 30s | 全局当前速率、连接数 |
| `rt:node:{node_id}:now` | HASH | 30s | 单节点当前速率、延迟、状态 |
| `rt:local:{node_id}:clients` | ZSET | 15m | 本地节点在线客户端 |
| `rt:client:{client_id}:now` | HASH | 15m | 客户端当前速率、来源、时长 |
| `stream:metrics:global` | STREAM | MAXLEN 5000 | 全局实时曲线 |
| `stream:metrics:node:{node_id}` | STREAM | MAXLEN 2000 | 单节点实时曲线 |
| `stream:events` | STREAM | MAXLEN 1000 | 近实时事件 |
| `lock:test:{node_id}` | STRING | 2m | 防止重复测试 |

### 5.2 rt:node:{id}:now 示例

```json
{
  "status": "online",
  "latency_ms": "42",
  "upload_bps": "4200000",
  "download_bps": "21800000",
  "active_connections": "23",
  "updated_at": "2026-06-11T10:28:14Z"
}
```

### 5.3 写入频率

| 数据 | 频率 | 存储 |
|---|---|---|
| 当前速率 | 1-5 秒 | Redis HASH |
| 短期曲线 | 5 秒 | Redis STREAM |
| 在线客户端 | 心跳 10 秒 | Redis ZSET/HASH |
| 每小时摘要 | 1 小时 | PostgreSQL |
| 每日摘要 | 1 天 | PostgreSQL |

### 5.4 Redis 到 PostgreSQL 聚合任务

后台任务每小时执行：

```text
1. 从 Redis 读取每个节点最近窗口累计值
2. 汇总 upload_bytes/download_bytes/error_count/avg_latency
3. UPSERT 到 daily_traffic_summaries
4. 不复制秒级明细到 PostgreSQL
```

---

## 6. 协议适配器设计

### 6.1 接口定义

```ts
interface NodeAdapter {
  protocol: string
  direction: 'remote' | 'local'

  parseLink?(input: string): ParsedNodeConfig
  getDefaultConfig(preset: Preset): NodeConfig
  validate(config: NodeConfig): ValidationResult
  mask(config: NodeConfig): SafeSummary
  renderEngineConfig(config: NodeConfig): EngineConfigFragment
  buildShareLink?(config: NodeConfig): string
  buildClientConfig?(config: NodeConfig, clientType: string): string
}
```

### 6.2 适配器目录

```text
backend/internal/adapters/
├── registry.go
├── http.go
├── socks5.go
├── shadowsocks.go
├── vmess.go
├── vless.go
├── trojan.go
├── wireguard.go
├── hysteria2.go
├── tuic.go
└── ssh_tunnel.go
```

### 6.3 前端表单 Schema

后端返回当前协议需要的表单结构，前端动态渲染：

```json
{
  "protocol": "vless",
  "direction": "remote",
  "required_fields": [
    {"key":"name", "label":"节点名称", "type":"text"},
    {"key":"server", "label":"服务器地址", "type":"text"},
    {"key":"port", "label":"端口", "type":"number"},
    {"key":"uuid", "label":"UUID", "type":"password"}
  ],
  "advanced_fields": [
    {"key":"transport.type", "label":"传输方式", "type":"select", "options":["tcp","ws","grpc"]},
    {"key":"tls.sni", "label":"TLS SNI", "type":"text"}
  ]
}
```

好处：新增协议时，主要改后端适配器和 Schema，不需要每个页面写一套表单。

---

## 7. 一键测试设计

### 7.1 测试任务阶段

远端节点：

```text
格式校验 → DNS 解析 → TCP/UDP 连接 → 协议握手 → 认证 → TLS → 延迟 → 小文件下载测速
```

本地节点：

```text
配置生成 → 端口占用检测 → 本机监听检测 → 认证检测 → 局域网检测 → 公网检测 → 分享链接生成
```

### 7.2 测试结果结构

```json
{
  "final_status": "passed",
  "latency_ms": 42,
  "steps": [
    {"name":"格式校验", "status":"passed", "message":"字段完整"},
    {"name":"连接测试", "status":"passed", "message":"握手成功"},
    {"name":"测速", "status":"warning", "message":"速度较低但可用"}
  ],
  "human_message": "节点可用，可以保存并启用。"
}
```

### 7.3 防重复测试

使用 Redis 锁：

```text
SET lock:test:{node_id} 1 NX EX 120
```

同一节点 2 分钟内只能运行一个测试任务。

---

## 8. API 设计

### 8.1 Auth

```http
POST /api/auth/login
POST /api/auth/logout
GET  /api/auth/me
PATCH /api/admin/password
```

### 8.2 Dashboard

```http
GET /api/dashboard/summary
GET /api/dashboard/health
GET /api/dashboard/events
```

### 8.3 远端节点

```http
GET    /api/remote-nodes
POST   /api/remote-nodes
GET    /api/remote-nodes/:id
PATCH  /api/remote-nodes/:id
DELETE /api/remote-nodes/:id
POST   /api/remote-nodes/import/parse
POST   /api/remote-nodes/:id/test
POST   /api/remote-nodes/:id/enable
POST   /api/remote-nodes/:id/disable
```

### 8.4 本地节点

```http
GET    /api/local-nodes
POST   /api/local-nodes
GET    /api/local-nodes/:id
PATCH  /api/local-nodes/:id
DELETE /api/local-nodes/:id
POST   /api/local-nodes/:id/test
POST   /api/local-nodes/:id/start
POST   /api/local-nodes/:id/stop
POST   /api/local-nodes/:id/restart
GET    /api/local-nodes/:id/share
POST   /api/local-nodes/:id/public-check
```

### 8.5 协议与表单

```http
GET /api/protocols?direction=remote
GET /api/protocols?direction=local
GET /api/protocols/:protocol/schema?direction=remote
GET /api/protocols/:protocol/schema?direction=local
```

### 8.6 实时监控

```http
GET /api/realtime/summary
GET /api/realtime/nodes/:id
GET /api/realtime/events
GET /api/realtime/stream        # SSE 或 WebSocket
```

### 8.7 系统设置

```http
GET  /api/system/status
GET  /api/system/settings
PATCH /api/system/settings
POST /api/system/backup
POST /api/system/update-check
POST /api/system/restart
```

---

## 9. 前端开发说明

### 9.1 页面路由

```text
/login
/setup-done
/dashboard
/remote-nodes
/remote-nodes/new
/remote-nodes/:id
/local-nodes
/local-nodes/new
/local-nodes/:id
/realtime
/settings
```

### 9.2 组件拆分

```text
components/
├── AppShell.vue / AppShell.tsx
├── MetricCard
├── StatusBadge
├── ProtocolSelector
├── SmartImportBox
├── DynamicProtocolForm
├── TestResultModal
├── ShareNodeModal
├── PublicCheckModal
├── AdvancedParamsDrawer
├── ConfirmDangerModal
└── RealtimeChart
```

### 9.3 小白模式实现

前端表单按字段分组：

```ts
type FieldGroup = 'basic' | 'auth' | 'network' | 'advanced'
```

默认只展示：`basic + auth`。点击“高级参数”才展示 `network + advanced`。

### 9.4 错误展示

后端返回：

```json
{
  "code": "TLS_HANDSHAKE_FAILED",
  "message": "TLS 握手失败，请检查 SNI、证书或 Reality 参数。",
  "field": "transport.tls.sni",
  "suggestion": "如果你不知道怎么填，先尝试留空并重新测试。"
}
```

前端必须把 `field` 对应的输入框标红，并显示 `suggestion`。

---

## 10. 后端开发说明

### 10.1 服务模块

| 模块 | 职责 |
|---|---|
| setup | 自动初始化数据库、Redis、管理员账号 |
| auth | 登录、JWT、修改密码 |
| nodes | 远端/本地节点 CRUD |
| adapters | 协议解析、校验、脱敏、配置生成 |
| engine | 生成代理核心配置、热加载、启动/停止节点 |
| metrics | Redis 实时数据写入/读取 |
| tests | 一键测试任务 |
| system | 备份、更新、状态检查 |

### 10.2 配置生成流程

```text
用户保存节点
→ adapter.validate()
→ adapter.mask()
→ 写入 PostgreSQL
→ adapter.renderEngineConfig()
→ engine.renderFullConfig()
→ engine.reload()
→ 写 audit_logs
```

### 10.3 热加载策略

MVP 可以先简单实现：

```text
1. 每次节点变更后生成完整配置文件
2. 调用代理核心 reload API 或重启代理核心进程
3. 更新 Redis 中节点状态
```

后续再优化成单节点热更新。

### 10.4 加密敏感字段

环境变量：

```text
CONFIG_ENCRYPTION_KEY=32字节随机值
```

保存到 PostgreSQL 前加密：

- password
- uuid
- private_key
- token
- preshared_key
- subscription_url

返回前端时只给脱敏值：

```text
********-****-****-****-************
```

---

## 11. 部署与运行设计

部署设计参考 sub2api 的“一键准备脚本 + Docker Compose + 本地目录数据挂载”思路，但不引入它的多用户、计费、OAuth 等复杂能力。本项目第一目标仍然是：没有运维能力的用户也能把面板跑起来、知道密码在哪里、知道数据在哪里、知道如何迁移。

### 11.1 推荐部署方式

| 方式 | 适合场景 | 数据位置 | 推荐级别 |
|---|---|---|---|
| Docker Compose 本地目录版 | 默认生产部署、需要备份迁移 | `./data`、`./postgres_data`、`./redis_data` | 首选 |
| Docker Compose 命名卷版 | 只想快速试用，不关心手动迁移 | Docker volume | 可选 |
| 二进制 + systemd | 高级用户、自带 PostgreSQL/Redis | 用户自定义 | P2 后补 |
| 反向代理 + HTTPS | 需要公网访问管理后台 | Caddy/Nginx 管理 TLS | 建议 |

默认发布包必须提供：

```text
deploy/
├── docker-compose.local.yml      # 本地目录挂载，便于备份迁移
├── docker-compose.yml            # 命名卷版本，简单试用
├── docker-compose.host.yml       # Linux host network 版本，便于动态开放本地节点端口
├── .env.example                  # 带完整注释的环境变量模板
├── install.sh                    # 一键准备脚本
├── Caddyfile.example             # HTTPS 反向代理示例
└── README.md                     # 部署、更新、迁移、排障命令
```

### 11.2 部署目录结构

本地目录版启动后目录如下：

```text
proxy-control-center/
├── docker-compose.yml
├── .env
├── data/
│   ├── engine/
│   │   ├── current.json
│   │   ├── previous.json
│   │   └── fragments/
│   ├── logs/
│   ├── backups/
│   └── uploads/
├── postgres_data/
└── redis_data/
```

说明：

- `.env` 保存所有部署密钥，权限应设置为 `0600`。
- `data/engine/current.json` 是当前代理核心完整配置。
- `data/engine/previous.json` 用于 reload 失败时回滚。
- `data/backups/` 保存后台手动触发的逻辑备份。
- PostgreSQL 和 Redis 默认不把端口映射到宿主机，只允许 app 通过 Docker 内部网络访问。

### 11.3 docker-compose.local.yml 关键设计

```yaml
services:
  app:
    image: yourname/proxy-control-center:${IMAGE_TAG:-latest}
    container_name: proxy-control-center
    restart: unless-stopped
    ports:
      - "${BIND_HOST:-127.0.0.1}:${SERVER_PORT:-8080}:8080"
      # 如需 Docker bridge 模式下开放本地节点端口，必须提前声明端口范围。
      # UI 创建本地节点时只能推荐这些已映射端口，否则一键测试提示“Docker 未映射端口”。
      - "${LOCAL_TCP_PORT_RANGE:-20000-20100}:${LOCAL_TCP_PORT_RANGE:-20000-20100}/tcp"
      - "${LOCAL_UDP_PORT_RANGE:-20000-20100}:${LOCAL_UDP_PORT_RANGE:-20000-20100}/udp"
    environment:
      AUTO_SETUP: "true"
      SERVER_HOST: "0.0.0.0"
      SERVER_PORT: "8080"
      DATABASE_URL: "postgres://${POSTGRES_USER:-proxy_panel}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB:-proxy_panel}?sslmode=disable"
      REDIS_URL: "redis://:${REDIS_PASSWORD:-}@redis:6379/${REDIS_DB:-0}"
      JWT_SECRET: "${JWT_SECRET}"
      CONFIG_ENCRYPTION_KEY: "${CONFIG_ENCRYPTION_KEY}"
      ADMIN_USERNAME: "${ADMIN_USERNAME:-admin}"
      ADMIN_PASSWORD: "${ADMIN_PASSWORD:-}"
      ENGINE_PROVIDER: "${ENGINE_PROVIDER:-sing-box}"
      ENGINE_RELOAD_TIMEOUT_SECONDS: "${ENGINE_RELOAD_TIMEOUT_SECONDS:-10}"
      LOG_LEVEL: "${LOG_LEVEL:-info}"
      TZ: "${TZ:-Asia/Shanghai}"
    volumes:
      - ./data:/app/data
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    networks:
      - proxy-control-center
    healthcheck:
      test: ["CMD", "wget", "-q", "-T", "5", "-O", "/dev/null", "http://localhost:8080/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 30s

  postgres:
    image: postgres:15-alpine
    container_name: proxy-control-center-postgres
    restart: unless-stopped
    environment:
      POSTGRES_DB: "${POSTGRES_DB:-proxy_panel}"
      POSTGRES_USER: "${POSTGRES_USER:-proxy_panel}"
      POSTGRES_PASSWORD: "${POSTGRES_PASSWORD}"
      TZ: "${TZ:-Asia/Shanghai}"
    volumes:
      - ./postgres_data:/var/lib/postgresql/data
    networks:
      - proxy-control-center
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-proxy_panel} -d ${POSTGRES_DB:-proxy_panel}"]
      interval: 10s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    container_name: proxy-control-center-redis
    restart: unless-stopped
    command: >
      sh -c 'redis-server
      --save 60 1
      --appendonly yes
      --appendfsync everysec
      ${REDIS_PASSWORD:+--requirepass "$REDIS_PASSWORD"}'
    environment:
      REDISCLI_AUTH: "${REDIS_PASSWORD:-}"
      TZ: "${TZ:-Asia/Shanghai}"
    volumes:
      - ./redis_data:/data
    networks:
      - proxy-control-center
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

networks:
  proxy-control-center:
    driver: bridge
```

端口策略：

- 管理后台默认绑定 `127.0.0.1:8080`，避免安装后直接暴露公网。
- 用户需要远程访问后台时，推荐用 Caddy/Nginx 提供 HTTPS。
- Docker bridge 模式无法在运行时动态新增端口映射，因此本地节点默认使用预留端口段。
- 如果用户明确需要任意端口或 443/80 低端口，本项目提供 `docker-compose.host.yml`，仅支持 Linux，并在说明中提示风险。

### 11.4 .env.example 完整分组

```env
# Server
IMAGE_TAG=latest
BIND_HOST=127.0.0.1
SERVER_PORT=8080
SERVER_MODE=release
TZ=Asia/Shanghai

# Admin
ADMIN_USERNAME=admin
# 留空时首次启动自动生成，并只在容器日志中打印一次。
ADMIN_PASSWORD=

# Security
JWT_SECRET=
JWT_EXPIRE_HOURS=24
CONFIG_ENCRYPTION_KEY=
COOKIE_SECURE=false
COOKIE_SAME_SITE=Lax
LOGIN_MAX_FAILURES=5
LOGIN_LOCK_MINUTES=15

# PostgreSQL
POSTGRES_DB=proxy_panel
POSTGRES_USER=proxy_panel
POSTGRES_PASSWORD=
DATABASE_MAX_OPEN_CONNS=50
DATABASE_MAX_IDLE_CONNS=10
DATABASE_CONN_MAX_LIFETIME_MINUTES=30

# Redis
REDIS_PASSWORD=
REDIS_DB=0
REDIS_POOL_SIZE=256
REALTIME_TTL_HOURS=6
REALTIME_MAX_TTL_HOURS=24

# Proxy Engine
ENGINE_PROVIDER=sing-box
ENGINE_CONFIG_DIR=/app/data/engine
ENGINE_RELOAD_TIMEOUT_SECONDS=10
ENGINE_HEALTHCHECK_TIMEOUT_SECONDS=5
LOCAL_TCP_PORT_RANGE=20000-20100
LOCAL_UDP_PORT_RANGE=20000-20100

# Subscription Import
SUBSCRIPTION_FETCH_TIMEOUT_SECONDS=15
SUBSCRIPTION_MAX_BYTES=1048576
SUBSCRIPTION_REFRESH_ENABLED=false
SUBSCRIPTION_REFRESH_CRON=0 3 * * *

# Backup
BACKUP_DIR=/app/data/backups
BACKUP_RETENTION_DAYS=30
BACKUP_BEFORE_UPDATE=true

# Logging
LOG_LEVEL=info
LOG_FORMAT=json
LOG_OUTPUT_TO_FILE=true
LOG_ROTATION_MAX_SIZE_MB=100
LOG_ROTATION_MAX_BACKUPS=10
LOG_ROTATION_MAX_AGE_DAYS=7
```

一键部署脚本必须自动生成：

- `POSTGRES_PASSWORD`
- `JWT_SECRET`
- `CONFIG_ENCRYPTION_KEY`

如果 `REDIS_PASSWORD` 留空，Redis 只在 Docker 内部网络使用；如果映射 Redis 到宿主机，则必须强制设置密码。

### 11.5 install.sh 逻辑

```bash
#!/usr/bin/env bash
set -euo pipefail

# 1. 检查 docker、docker compose、openssl、curl/wget
# 2. 如果当前目录已有 docker-compose.yml 或 .env，询问是否覆盖
# 3. 下载 docker-compose.local.yml 并保存为 docker-compose.yml
# 4. 下载 .env.example
# 5. 复制 .env.example 为 .env
# 6. 生成 POSTGRES_PASSWORD / JWT_SECRET / CONFIG_ENCRYPTION_KEY
# 7. 写入 .env，并 chmod 600 .env
# 8. 创建 data / postgres_data / redis_data
# 9. 打印下一步命令：docker compose up -d
# 10. 提示：如果 ADMIN_PASSWORD 留空，请用 docker compose logs app 查看首次生成密码
```

脚本只负责“准备部署目录”，不强制自动启动。这样用户可以先检查 `.env` 和端口绑定，再执行 `docker compose up -d`。

### 11.6 更新与回滚

更新前默认执行备份：

```bash
docker compose exec app proxy-control-center backup create --reason before-update
docker compose pull
docker compose up -d
```

如果更新失败：

```bash
# 将 .env 中 IMAGE_TAG 改回上一个可用版本，然后重启。
docker compose up -d
```

发布说明必须记录每个版本的镜像标签。应用层必须保留最近一次可用的代理核心配置 `previous.json`。如果新版配置生成或 reload 失败，自动回滚代理核心，不影响管理后台登录。

---

## 12. 代理核心与端口运行边界

### 12.1 MVP 代理核心选择

MVP 固定优先支持 `sing-box`，原因是协议覆盖较广、配置结构清晰、适合统一生成本地 inbound 和远端 outbound。`xray` 作为 P3 适配器扩展，不进入第一版验收。

内部接口仍保持抽象：

```text
adapter.renderEngineConfig()
→ engine.renderFullConfig()
→ engine.validate()
→ engine.reload()
→ engine.healthcheck()
```

### 12.2 配置生成与热加载事务

每次保存并启用节点时必须按事务流程执行：

```text
1. 读取 PostgreSQL 中全部 enabled 节点
2. 生成临时完整配置 data/engine/next.json
3. 调用 sing-box check 校验配置
4. 备份 current.json 为 previous.json
5. next.json 覆盖 current.json
6. reload 或重启代理核心
7. 健康检查通过后提交节点状态
8. 失败则恢复 previous.json 并再次 reload
```

失败时用户看到的文案：

```text
节点已保存，但代理核心重载失败，系统已回滚到上一个可用配置。
请检查端口是否被占用，或查看节点详情中的测试结果。
```

### 12.3 Docker 端口限制

Docker bridge 模式下，容器运行后不能动态新增宿主机端口映射。因此本地节点创建时必须检测：

- 用户选择的监听端口是否在 `LOCAL_TCP_PORT_RANGE` / `LOCAL_UDP_PORT_RANGE` 内。
- 用户选择 80/443/51820 等端口时，compose 是否显式映射。
- 如果未映射，允许保存草稿，但不允许启用，并给出明确提示。

提示示例：

```text
这个端口没有映射到 Docker 宿主机。请改用 20000-20100 之间的端口，或切换到 host network 部署方式。
```

### 12.4 特权能力边界

默认 Docker 部署不启用特权模式。

| 能力 | 默认状态 | 说明 |
|---|---|---|
| 普通 TCP/UDP 代理端口 | 支持 | 需要 compose 映射端口 |
| 低端口 80/443 | 可支持 | 需要宿主机权限和端口映射 |
| WireGuard userspace | P1 可支持 | 优先不依赖内核模块 |
| TUN 模式 | 默认关闭 | 需要 `/dev/net/tun` 和 `NET_ADMIN`，高级用户手动开启 |
| 修改系统路由 | 不支持 | 不做“接管整机网络”的功能 |

如果用户开启 TUN 或 host network，设置页必须显示“高级网络模式已开启”，并提示该模式会改变容器网络隔离边界。

---

## 13. 订阅导入与分享生命周期

### 13.1 远端订阅导入

支持输入：

- 单个分享链接：`vmess://`、`vless://`、`trojan://`、`ss://`、`hysteria2://`
- 订阅 URL
- Clash YAML 片段
- Sing-box JSON 片段

解析规则：

- 解析结果先进入预览页，用户勾选后导入。
- 同一订阅内部分节点失败时，成功节点仍可导入，失败项显示原因。
- 默认按 `protocol + server + port + credential fingerprint` 去重。
- 重复节点默认更新已有配置，保留用户自定义名称和备注。
- 订阅 URL 加密保存，前端只展示脱敏域名。

### 13.2 订阅刷新

MVP 默认不自动刷新订阅。P2 可开启：

```text
SUBSCRIPTION_REFRESH_ENABLED=true
SUBSCRIPTION_REFRESH_CRON=0 3 * * *
```

刷新策略：

- 后台定时任务拉取订阅。
- 使用 Redis 锁防止同一订阅并发刷新。
- 新增节点默认保存为草稿，除非订阅源被用户标记为“自动启用新增节点”。
- 订阅删除的节点不直接删除本地配置，默认标记为“订阅源已移除”，由用户确认。

### 13.3 订阅拉取安全

订阅 URL 拉取必须防 SSRF：

- 只允许 `http` 和 `https`。
- 默认禁止访问内网 IP、localhost、link-local、metadata 地址。
- 默认限制响应体大小，建议 `1MB`。
- 默认超时 15 秒。
- 最多跟随 3 次重定向，每次重定向后重新校验目标地址。

如果用户确实需要导入内网订阅，必须在系统设置中显式开启“允许内网订阅地址”，并写入审计日志。

### 13.4 本地节点分享

本地节点分享输出包括：

- 单节点链接
- 二维码
- Clash 配置片段
- Sing-box 配置片段
- WireGuard 配置文件
- 订阅链接

分享安全规则：

- 分享链接包含凭据时必须显示风险提示。
- 每个本地节点有独立 `share_token`，支持一键轮换。
- 轮换后旧订阅链接立即失效。
- 分享链接默认不公开列目录，只返回当前节点配置。
- 订阅接口必须限速，避免被扫爆。

---

## 14. 备份、迁移与恢复

### 14.1 备份方式

| 方式 | 内容 | 适合场景 |
|---|---|---|
| 整目录冷备 | `.env`、`data`、`postgres_data`、`redis_data` | 整机迁移、最简单 |
| PostgreSQL 逻辑备份 | 管理员、节点配置、审计、摘要 | 在线备份、跨版本恢复 |
| 配置导出 | 节点配置脱敏摘要 | 排障或人工核对 |

整目录冷备：

```bash
docker compose down
cd ..
tar czf proxy-control-center-backup.tar.gz proxy-control-center/
```

恢复：

```bash
tar xzf proxy-control-center-backup.tar.gz
cd proxy-control-center
docker compose up -d
```

### 14.2 逻辑备份

后台“备份”按钮触发：

```text
1. 检查 BACKUP_DIR 可写
2. 执行 pg_dump，导出 PostgreSQL
3. 复制 data/engine/current.json 和必要系统设置
4. 写入 backup_manifest.json
5. 删除超过 BACKUP_RETENTION_DAYS 的旧备份
```

`backup_manifest.json` 示例：

```json
{
  "version": "1.0.0",
  "created_at": "2026-06-11T10:00:00Z",
  "database": "postgresql",
  "engine_provider": "sing-box",
  "contains_secrets": true,
  "encryption_key_fingerprint": "sha256:xxxx"
}
```

### 14.3 恢复校验

恢复后必须校验：

- `.env` 中的 `CONFIG_ENCRYPTION_KEY` 是否与备份指纹一致。
- 数据库 migrations 是否完整执行。
- 管理员账号是否存在且唯一。
- 节点配置数量、启用状态、最后测试摘要是否可读。
- 代理核心配置是否能重新生成并通过 `engine.check()`。

如果 `CONFIG_ENCRYPTION_KEY` 丢失，系统无法解密已保存的密码、UUID、私钥和订阅 URL。此时只能保留脱敏摘要，不能恢复可用节点。

---

## 15. 安全边界

- 系统仅供管理员自己使用，不暴露注册入口。
- 管理后台默认只绑定本机地址，公网访问必须建议前置 HTTPS 反向代理。
- 首次随机管理员密码只在初始化日志中打印一次，首次登录后提示修改。
- 登录失败超过阈值后锁定一段时间，并写入审计日志。
- Cookie 使用 `HttpOnly`，公网 HTTPS 场景应开启 `Secure`。
- 修改密码、备份、更新、删除节点、轮换分享链接必须写审计日志。
- 本地节点分享链接包含凭据，必须提示用户谨慎分享。
- 默认不保存完整流量包 payload。
- 默认脱敏 IP、UUID、密码、密钥。
- Redis 中的实时客户端数据 TTL 自动过期。
- 删除节点时只删除配置，不删除审计摘要。
- 订阅 URL 拉取必须做 SSRF 防护。
- 反向代理场景必须正确处理 `X-Forwarded-Proto`，避免错误生成 `http` 分享链接。

### 15.1 反向代理建议

公网管理后台推荐：

```text
client → HTTPS(Caddy/Nginx) → 127.0.0.1:8080 → app
```

反向代理必须支持：

- WebSocket 或 SSE，用于实时监控。
- 请求体大小限制，避免异常大配置导入。
- 合理的超时设置，避免一键测试长时间占用连接。
- HTTPS 自动续期或证书更新说明。

---

## 16. 日志、健康检查与运维

### 16.1 日志

日志默认同时输出到 stdout 和 `data/logs/`：

| 项 | 默认值 |
|---|---|
| `LOG_LEVEL` | `info` |
| `LOG_FORMAT` | `json` |
| `LOG_ROTATION_MAX_SIZE_MB` | `100` |
| `LOG_ROTATION_MAX_BACKUPS` | `10` |
| `LOG_ROTATION_MAX_AGE_DAYS` | `7` |

日志内容规则：

- 不打印明文密码、UUID、私钥、订阅 URL。
- 初始化随机管理员密码允许打印一次，但必须带明显提示。
- 一键测试日志记录阶段和错误码，不记录完整代理凭据。
- 代理核心 stderr/stdout 单独写入 `data/logs/engine.log`。

### 16.2 健康检查接口

```http
GET /health
GET /ready
GET /api/system/status
```

含义：

- `/health`：进程存活即可返回 200。
- `/ready`：PostgreSQL、Redis、migrations、代理核心状态均正常才返回 200。
- `/api/system/status`：给前端展示详细状态，包括数据库、Redis、代理核心、磁盘占用、版本信息。

### 16.3 常用运维命令

部署 README 必须提供：

```bash
docker compose up -d
docker compose down
docker compose logs -f app
docker compose restart app
docker compose pull && docker compose up -d
docker compose exec app proxy-control-center backup create
docker compose exec app proxy-control-center system status
```

---

## 17. 开发优先级

### P0

- Docker Compose 本地目录版一键启动。
- install.sh 生成 `.env`、密钥和数据目录。
- AUTO_SETUP 初始化。
- 单管理员登录。
- PostgreSQL migrations。
- Redis 健康检查。
- app `/health` 和 `/ready`。
- sing-box MVP 集成与配置生成。

### P1

- 远端节点添加、导入、测试、保存。
- 本地节点创建、端口映射检测、测试、分享。
- 协议适配器框架。
- 节点详情页。
- 代理核心 reload 失败回滚。
- 分享 token 轮换。

### P2

- 实时监控 Redis 写入/读取。
- 每日摘要聚合。
- 系统设置、修改密码、备份说明。
- 订阅定时刷新。
- Caddy/Nginx 反向代理示例。
- 二进制 + systemd 部署文档。

### P3

- 更多协议适配器。
- xray 引擎适配器。
- 更完整的公网检测。
- 一键更新。
- 订阅聚合与客户端模板。
- TUN/WireGuard 高级网络模式。

---

## 18. 验收标准

### 18.1 小白可用性

- 用户不懂协议时，可以通过“智能识别”导入。
- 创建本地节点时，用户只需要选择“给谁用”。
- 每次失败都能看到清晰原因和下一步建议。
- 保存成功后能直接复制二维码或配置。
- Docker 端口未映射时，页面能明确告诉用户改用哪个端口或切换部署方式。

### 18.2 数据占用

- Redis 中秒级数据会自动过期。
- PostgreSQL 不保存秒级明细。
- 默认只保存每日摘要 180 天。
- 日志默认滚动，不会无限增长。

### 18.3 部署

- 一条命令准备部署目录。
- 一条命令拉起 app + PostgreSQL + Redis。
- 首次启动自动创建管理员。
- 未设置管理员密码时，日志可以查到随机密码。
- 管理后台默认不直接暴露公网。
- PostgreSQL 和 Redis 默认不映射宿主机端口。
- 所有数据目录可打包迁移。

### 18.4 工程测试

- migrations 可以重复执行，不会破坏已有数据。
- migration checksum 变化时能阻止异常启动并给出清晰错误。
- `.env` 中缺少必填密钥时，启动失败并说明如何生成。
- 协议适配器有 golden config 测试。
- 分享链接生成有脱敏和撤销测试。
- 订阅导入有 vmess/vless/trojan/ss/Clash/Sing-box fixture。
- 代理核心 reload 失败时能恢复 `previous.json`。
- Redis 锁能阻止同一节点并发测试。

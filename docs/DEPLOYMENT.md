# AgentProject 部署说明

## 部署形态

当前项目的生产部署形态为：

- `postgres`：数据库
- `backend`：FastAPI 服务
- `nginx`：前端静态资源、API 反向代理、下载目录

对应编排文件：

- `docker-compose.yml`
- `deploy/Dockerfile.nginx`
- `deploy/nginx.conf`
- `backend/Dockerfile`

## 当前已验证的部署目录

服务器部署目录默认使用：

```text
/root/PersonalSpace/AgentProject
```

这也是当前 `CD` 的默认值。

## 服务器前置条件

至少满足：

- 已安装 Docker
- 已安装 Docker Compose
- 22 端口已开放
- 80 端口已开放
- 部署目录下存在可用 `.env`
- SSH 用户有权限执行 `docker compose`

若当前线上服务器仍是既有环境，可继续使用：

- 服务器 IP：`47.118.23.188`
- 部署目录：`/root/PersonalSpace/AgentProject`

## 目录结构要求

部署目录至少需要这些子目录：

```bash
mkdir -p /root/PersonalSpace/AgentProject/data/postgres
mkdir -p /root/PersonalSpace/AgentProject/data/uploads
mkdir -p /root/PersonalSpace/AgentProject/data/chroma
mkdir -p /root/PersonalSpace/AgentProject/data/downloads
mkdir -p /root/PersonalSpace/AgentProject/logs
```

## 必备配置

项目根目录下必须存在：

```text
/root/PersonalSpace/AgentProject/.env
```

建议重点检查这些变量：

- `SECRET_KEY`
- `DATABASE_URL` 或 PostgreSQL 相关配置
- `AUTO_RUN_MIGRATIONS`
- `ZHIPU_API_KEY`
- `WEB_APP_URL`
- `VITE_API_BASE_URL`
- `API_ORIGINS`
- `INITIAL_ADMIN_USERNAME`
- `INITIAL_ADMIN_EMAIL`
- `INITIAL_ADMIN_PASSWORD`
- `DESKTOP_RELEASE_VERSION`
- `DESKTOP_RELEASE_FILE`

## Docker 启动

在部署目录执行：

```bash
cd /root/PersonalSpace/AgentProject
docker compose up -d --build --remove-orphans
```

查看状态：

```bash
docker compose ps
docker compose logs -f backend
docker compose logs -f nginx
```

说明：

- 当前后端启动时，`SQLite` 仍走元数据 bootstrap
- 非 `SQLite` 环境默认会优先执行 Alembic 迁移
- 如果检测到历史业务表但没有 `alembic_version`，会自动补齐缺失表并 `stamp head`

## 网页资源与更新恢复

`deploy/nginx.conf` 对 HTML 和 SPA 路由返回 `Cache-Control: no-cache`，浏览器可保存页面但再次使用前需要校验。`/assets/` 是 Vite 的内容哈希资源目录，成功响应缓存一年并标为 `immutable`；缺失的旧哈希返回 `404`，不会回退为 HTML 或带长期缓存头。发布时须一起更新入口 HTML 与其引用的资源。

已经打开的旧标签页仍可能持有已移除的分包地址；网页提供显式刷新恢复，不自动循环刷新，也不清除登录信息。本地真实 Nginx 测试覆盖两套 server 的状态、缓存、MIME 和 HEAD/304；不代表已完成线上 TLS 或发布切换验收。

## 安装包发布

桌面安装包路径：

```text
data/downloads/Detachym-<desktop-version>-x64.exe
```

对外下载地址：

```text
/download/Detachym-<desktop-version>-x64.exe
```

版本接口：

```text
/api/v1/public/version/win-x64
```

准确版本与文件名由 `desktop/package.json` 和同次构建的发布清单确定，服务器配置使用 `DESKTOP_RELEASE_VERSION` 与 `DESKTOP_RELEASE_FILE`。旧安装包保留原文件名，不能用新包覆盖旧版本文件。

## 首次初始化与手工部署

以下用于环境初始化或经核对的人工恢复。正常发布使用 PR 合入 `main` 后的 GitHub CD；不要与同一次自动 CD 并行部署。`deploy/deploy.sh` 是 dnf 系统的初始 Docker 安装脚本，不提供本次发布的 main/CI/安装包校验与回滚。

### 1. 准备代码

```bash
cd /root/PersonalSpace
git clone https://github.com/qsjkc/AgentProject.git AgentProject
cd AgentProject
```

若目录已存在：

```bash
cd /root/PersonalSpace/AgentProject
git pull origin main
```

### 2. 准备 `.env`

```bash
cd /root/PersonalSpace/AgentProject
vim .env
```

### 3. 准备运行目录

```bash
mkdir -p data/postgres data/uploads data/chroma data/downloads logs
```

### 4. 放置安装包

将桌面端安装包上传到：

```text
/root/PersonalSpace/AgentProject/data/downloads/Detachym-<desktop-version>-x64.exe
```

### 5. 启动服务

```bash
cd /root/PersonalSpace/AgentProject
docker compose up -d --build --remove-orphans
```

## GitHub CD 部署步骤

正常发布流程以 `.github/workflows/cd.yml` 为准：

1. PR 合入 `main`，等待该精确 SHA 的 `CI` 成功后触发 `CD`
2. `CD` 锁定当前 `main` SHA；旧提交的 CI、非 main 手动部署或没有成功 CI 的手动部署会停止
3. `desktop-installer` 在 Windows runner 构建唯一安装包与 `desktop-release.json`（版本、文件名、字节数、SHA-256、源提交）
4. `deploy-server` 等待安装包成功后下载并验证同一次运行的 artifact；在首次远端变更前再核对 main 没有移动
5. 通过原生 `ssh/scp` 核对线上版本及 Alembic revision，上传源码及暂存安装包，校验哈希后原子改名
6. 保留服务器 `.env` 和业务数据，保存原发布键，仅更新 `DESKTOP_RELEASE_VERSION`、`DESKTOP_RELEASE_FILE`；原有 Agent 公网地址修正逻辑继续保留
7. 主服务及 `agent-server/` 执行 `docker compose up -d --build --remove-orphans`
8. 后端、Agent 就绪后验证公网 HTTPS readiness、版本元数据及安装包 HEAD/长度；成功后写 `.deployed-release.json`，上传 `server-release-verification` 验证 artifact

说明：

- 当前已经不再使用 `appleboy/ssh-action`
- SSH 必须配置私钥 `SERVER_SSH_KEY`，不支持密码单独登录
- 不再通过 `APP_ENV_FILE` Secret 覆盖服务器 `.env`
- SSH 主机 IP 与公网 TLS 域名可以不同，公网检查优先使用 `WEB_APP_URL`
- 当前源码上传时会排除 `frontend/node_modules` 等本机依赖目录
- 解包前会先清理远端旧的 `frontend/node_modules`
- 固定并发组将 CD 排队，避免后续运行中断正在进行的服务切换

合并后跟踪 `CI` 和自动 `CD`，不要重复触发手工部署。只有需要重跑且没有同批自动部署时使用：

```bash
gh workflow run cd.yml --ref main -f ref=main
gh run list --workflow cd.yml --branch main
gh run watch <run-id> --exit-status
```

`.release-state-before-<sha>.env` 仅记录原来的两个发布键，当前 CD 不会自动备份或回滚生产库。回退需配套恢复对应应用、数据库及配置，不能把旧代码覆盖或 Alembic downgrade 当作无损回退。历史回退位置以 `P1L-部署验收记录.md` 为据，使用前须检查实际备份。

## 为什么要防 `node_modules` 污染

本项目的 `nginx` 镜像在构建时需要在 Linux 容器中执行：

```bash
npm ci
npm run build
```

如果上传到服务器的源码里夹带了 Windows 下的 `frontend/node_modules`，会导致：

```text
sh: tsc: Permission denied
```

当前修复方式有两层：

1. `.dockerignore` 排除 `node_modules`
2. `deploy/Dockerfile.nginx` 在 build 前强制：

```dockerfile
rm -rf node_modules && npm ci && npm run build
```

## 部署后检查

### 本机检查

```bash
curl http://127.0.0.1/health
curl http://127.0.0.1/health/ready
curl http://127.0.0.1/api/v1/public/version/win-x64
```

### 容器检查

```bash
docker compose ps
docker compose logs --tail=100 backend
docker compose logs --tail=100 nginx
```

### 对外检查

- 首页可访问
- `/health` 返回正常
- `/health/ready` 返回 `ready`
- `/api/v1/public/version/win-x64` 返回版本信息
- 版本接口返回的安装包 URL 可下载，HEAD 长度与同次构建的清单一致

## 常见问题

| 问题 | 原因 | 处理 |
|---|---|---|
| `Missing .env` | 生产配置文件缺失 | 先手工补好 `.env` |
| `unable to authenticate` | SSH key 不正确或服务器未接受密钥 | 先在本机用同一把私钥测试 |
| `Bad port ''` | 端口值异常 | 检查 `SERVER_PORT`，当前 workflow 已做端口兜底 |
| `hostname contains invalid characters` | `SERVER_HOST` 带协议头/路径/用户名 | 建议 Secret 只填主机或 IP |
| `tsc: Permission denied` | 前端依赖目录污染 Linux 构建 | 检查 `.dockerignore` 和上传排除项 |

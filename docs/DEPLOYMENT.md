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

## 安装包发布

桌面安装包路径：

```text
data/downloads/DetachymAgentPet1.0.exe
```

对外下载地址：

```text
/download/DetachymAgentPet1.0.exe
```

版本接口：

```text
/api/v1/public/version/win-x64
```

## 手工部署步骤

若不通过 GitHub Actions，也可以手工部署。

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
/root/PersonalSpace/AgentProject/data/downloads/DetachymAgentPet1.0.exe
```

### 5. 启动服务

```bash
cd /root/PersonalSpace/AgentProject
docker compose up -d --build --remove-orphans
```

## GitHub CD 部署步骤

当前 `CD` 已经跑通，实际流程如下：

1. `CI` 在 `main` 成功后触发 `CD`
2. `desktop-installer` 在 Windows runner 构建安装包
3. `deploy-server` 用原生 `ssh/scp` 登录服务器
4. 上传源码压缩包与安装包
5. 服务器端执行 `docker compose up -d --build --remove-orphans`

说明：

- 当前已经不再使用 `appleboy/ssh-action`
- 当前源码上传时会排除 `frontend/node_modules` 等本机依赖目录
- 解包前会先清理远端旧的 `frontend/node_modules`

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
- `/download/DetachymAgentPet1.0.exe` 可下载

## 常见问题

| 问题 | 原因 | 处理 |
|---|---|---|
| `Missing .env` | 生产配置文件缺失 | 先手工补好 `.env` |
| `unable to authenticate` | SSH key 不正确或服务器未接受密钥 | 先在本机用同一把私钥测试 |
| `Bad port ''` | 端口值异常 | 检查 `SERVER_PORT`，当前 workflow 已做端口兜底 |
| `hostname contains invalid characters` | `SERVER_HOST` 带协议头/路径/用户名 | 建议 Secret 只填主机或 IP |
| `tsc: Permission denied` | 前端依赖目录污染 Linux 构建 | 检查 `.dockerignore` 和上传排除项 |

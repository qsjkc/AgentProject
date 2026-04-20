# AgentProject CI/CD 说明

## 目标

本文档描述仓库当前已经落地并跑通的 GitHub Actions 自动化流程，覆盖：

- `CI`：后端测试、前端检查、桌面端 renderer 构建检查
- `CD`：桌面安装包构建、可选 Docker 镜像推送、可选服务器部署

当前实现以仓库中的以下文件为准：

- `.github/workflows/ci.yml`
- `.github/workflows/cd.yml`
- `deploy/Dockerfile.nginx`
- `docker-compose.yml`
- `.dockerignore`

## Workflow 总览

| Workflow | 文件 | 触发条件 | 作用 |
|---|---|---|---|
| `CI` | `.github/workflows/ci.yml` | `push` 到 `main/develop`、对 `main` 的 `pull_request`、手动触发 | 做基础质量门禁 |
| `CD` | `.github/workflows/cd.yml` | `CI` 在 `main` 成功完成后自动触发，或手动触发 | 构建安装包、可选推镜像、可选部署服务器 |

## CI 流程

### 1. Backend Tests

- Runner：`ubuntu-latest`
- Python：`3.11`
- 工作目录：`backend/`
- 关键命令：

```bash
python -m pip install --upgrade pip
pip install -r requirements.txt
pytest -q -p no:cacheprovider tests/test_main.py
```

说明：

- 测试运行时使用 `tests/.runtime/` 作为隔离目录
- 使用 `-p no:cacheprovider` 避免 CI 写入 pytest cache

### 2. Frontend Checks

- Runner：`ubuntu-latest`
- Node.js：`20`
- 工作目录：`frontend/`
- 关键命令：

```bash
npm ci
npm run lint
npm run build
```

### 3. Desktop Renderer Build

- Runner：`ubuntu-latest`
- Node.js：`20`
- 工作目录：`desktop/`
- 关键命令：

```bash
npm ci
npm run build:renderer
```

说明：

- `CI` 只检查 `renderer` 构建，不在常规门禁里打 Windows 安装包
- 真正的安装包构建放到 `CD`

## CD 流程

### 触发方式

1. `CI` 在 `main` 分支成功完成后自动触发
2. 手动触发 `workflow_dispatch`，可指定 `ref`

### 1. Preflight

`preflight` 负责做部署前变量解析，并决定后续哪些 Job 启用。

输出内容：

- `deploy_ref`
- `app_dir`
- `server_port`
- `docker_enabled`
- `server_enabled`

说明：

- `SERVER_APP_DIR` 默认值：`/root/PersonalSpace/AgentProject`
- `SERVER_PORT` 默认值：`22`
- 若未配置 Docker Hub 凭据，则 `docker-publish` 自动跳过
- 若未配置服务器登录凭据，则 `deploy-server` 自动跳过

### 2. Desktop Installer

- Runner：`windows-latest`
- 工作目录：`desktop/`
- 关键命令：

```powershell
npm ci
npm run build
```

产物：

- `desktop/dist/releases/DetachymAgentPet1.0.exe`

并上传为 GitHub Actions Artifact：

- `agentproject-desktop-win`

### 3. Publish Docker Images

若配置了：

- `DOCKER_USERNAME`
- `DOCKER_PASSWORD`

则会构建并推送：

- `${DOCKER_USERNAME}/agentproject-backend:latest`
- `${DOCKER_USERNAME}/agentproject-nginx:latest`

### 4. Deploy Server

若配置了：

- `SERVER_HOST`
- `SERVER_USERNAME`
- `SERVER_SSH_KEY` 或 `SERVER_PASSWORD`

则会执行服务器部署。

当前部署方式说明：

- 不再使用 `appleboy/ssh-action` / `appleboy/scp-action`
- 改为在 runner 内写入私钥，并使用原生 `ssh` / `scp`
- 先解析并清洗部署目标，再生成统一的 SSH config 别名 `deploy-target`

执行顺序：

1. 下载桌面安装包 artifact
2. 写入 `~/.ssh/id_ed25519`
3. 解析部署目标
4. 创建远端目录
5. 上传应用源码压缩包
6. 上传桌面安装包
7. 在服务器执行：

```bash
docker compose up -d --build --remove-orphans
docker compose ps
```

8. 在服务器执行部署后就绪检查：

```bash
python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:5000/health/ready'); urllib.request.urlopen('http://127.0.0.1:5000/api/v1/public/version/win-x64')"
```

## 服务器部署变量解析规则

`deploy-server` 对部署目标做了容错处理，支持以下输入：

- `SERVER_HOST=47.118.23.188`
- `SERVER_HOST=detachym.top`
- `SERVER_HOST=47.118.23.188:22`
- `SERVER_HOST=ssh://47.118.23.188:22`
- `SERVER_HOST=root@47.118.23.188`

workflow 会自动：

- 去掉 `ssh://`、`http://`、`https://`
- 去掉路径部分
- 去掉 `user@`
- 如果 host 中带了端口，自动拆分端口

建议仍然优先使用最简单的值：

```text
SERVER_HOST=47.118.23.188
SERVER_PORT=22
SERVER_USERNAME=root
SERVER_APP_DIR=/root/PersonalSpace/AgentProject
```

## 需要配置的 GitHub Secrets

### Docker 相关

| Secret | 说明 |
|---|---|
| `DOCKER_USERNAME` | Docker Hub 用户名 |
| `DOCKER_PASSWORD` | Docker Hub 密码或 Access Token |

### 服务器部署相关

| Secret | 说明 |
|---|---|
| `SERVER_HOST` | 服务器地址，推荐只填主机或 IP |
| `SERVER_PORT` | SSH 端口，可选，默认 `22` |
| `SERVER_USERNAME` | SSH 登录用户 |
| `SERVER_PASSWORD` | SSH 密码，可选 |
| `SERVER_SSH_KEY` | SSH 私钥全文，可选，和密码二选一 |
| `SERVER_APP_DIR` | 部署目录，可选，默认 `/root/PersonalSpace/AgentProject` |

## 服务器端前置条件

目标服务器至少需要满足：

- 已安装 Docker
- 已安装 Docker Compose
- 部署目录下已经存在可用 `.env`
- SSH 用户有权限执行 `docker compose`
- 80 端口已开放，若使用 SSH 则 22 端口已开放

## 防污染设计

当前 `CD` 已经针对前端依赖污染问题做了双重防护。

### 1. 上传源码时排除本机依赖目录

`Upload application source` 会显式排除：

- `frontend/node_modules`
- `frontend/dist`
- `frontend/.vite`
- `backend/venv`
- `backend/__pycache__`
- `backend/**/*.pyc`

### 2. 服务器解包前清理旧脏目录

远端解包前会先删除：

- `frontend/node_modules`
- `frontend/dist`
- `frontend/.vite`
- `backend/venv`

### 3. Nginx 构建阶段强制重新安装前端依赖

`deploy/Dockerfile.nginx` 当前做法：

```dockerfile
COPY frontend/package*.json ./frontend/
RUN cd frontend && npm ci

COPY frontend ./frontend
RUN cd frontend && rm -rf node_modules && npm ci && npm run build
```

这一步是为了避免 Windows 下的 `node_modules/.bin/tsc` 污染 Linux 容器，导致：

```text
sh: tsc: Permission denied
```

## 当前实现的意义

本次 CI/CD 方案与此前版本相比，核心变化有：

- `CI` / `CD` 职责分离
- `desktop` 安装包放到 `CD` 再构建
- `deploy-server` 改用原生 `ssh/scp`
- 对 `SERVER_HOST`、`SERVER_PORT` 做容错解析
- 对前端 `node_modules` 污染链路做了完整封堵
- 部署完成后增加了后端就绪检查和公开版本接口探测

## 常见失败与定位

| 现象 | 高概率原因 | 处理思路 |
|---|---|---|
| `unable to authenticate` | SSH Secret 不正确或服务器未接受密钥 | 先在本机用同一把私钥执行 `ssh -o IdentitiesOnly=yes` 验证 |
| `Bad port ''` | 端口变量为空或被错误解析 | 检查 `SERVER_PORT`，当前 workflow 已做兜底 |
| `hostname contains invalid characters` | `SERVER_HOST` 含协议头、路径或用户名 | workflow 已做清洗，但仍建议 Secret 只填纯主机/IP |
| `sh: tsc: Permission denied` | Windows `node_modules` 污染了 Linux 构建环境 | 检查 `.dockerignore`、源码打包排除项、Dockerfile 重装依赖逻辑 |
| `Missing .env` | 服务器部署目录没有 `.env` | 先手工准备生产 `.env` |
| `docker compose` 执行失败 | 服务器未安装 Docker/Compose 或权限不足 | 在服务器上先验证 `docker --version`、`docker compose version` |

## 推荐的部署后检查

服务器部署完成后，至少检查：

```bash
cd /root/PersonalSpace/AgentProject
docker compose ps
docker compose logs --tail=100 backend
docker compose logs --tail=100 nginx
```

对外检查：

- `/health`
- `/health/ready`
- `/api/v1/public/version/win-x64`
- `/download/DetachymAgentPet1.0.exe`

## 当前结论

截至当前版本，仓库内的 `CI` 与 `CD` 已按现有配置跑通，并且部署后已经包含后端 readiness 校验。后续若要继续增强，优先建议：

1. 为 Docker 镜像发布增加版本号 tag，而不只使用 `latest`
2. 将当前“上传源码到服务器再构建”逐步演进为“镜像优先部署”
3. 若服务器网络环境稳定，再考虑恢复更严格的 host key 校验策略

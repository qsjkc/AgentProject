# AgentProject CI/CD 说明

## 目的

本文件说明仓库当前使用的 GitHub Actions 自动化流程，包括：

- `CI`：后端测试、前端检查、桌面端 renderer 构建检查
- `CD`：桌面安装包构建、可选 Docker 镜像推送、可选服务器部署

## Workflow 列表

### `.github/workflows/ci.yml`

触发条件：

- 推送到 `main`
- 推送到 `develop`
- 向 `main` 发起 Pull Request
- 手动触发

执行内容：

1. `backend-tests`
   - Python 3.11
   - 安装 `backend/requirements.txt`
   - 执行 `pytest -q -p no:cacheprovider tests/test_main.py`
2. `frontend-checks`
   - Node.js 20
   - `npm ci`
   - `npm run lint`
   - `npm run build`
3. `desktop-renderer-check`
   - Node.js 20
   - `npm ci`
   - `npm run build:renderer`

### `.github/workflows/cd.yml`

触发条件：

- `CI` 在 `main` 分支成功完成后自动触发
- 手动触发，可指定 `ref`

执行内容：

1. `desktop-installer`
   - 在 Windows Runner 构建 `DetachymAgentPet1.0.exe`
   - 上传为 GitHub Actions Artifact
2. `docker-publish`
   - 若配置了 Docker Hub 凭据，则构建并推送：
     - `agentproject-backend:latest`
     - `agentproject-nginx:latest`
3. `deploy-server`
   - 若配置了服务器 SSH 凭据，则上传项目源码与桌面安装包
   - 在目标服务器执行 `docker compose up -d --build --remove-orphans`

## 需要配置的 GitHub Secrets

### Docker 镜像推送

| Secret | 用途 |
|---|---|
| `DOCKER_USERNAME` | Docker Hub 用户名 |
| `DOCKER_PASSWORD` | Docker Hub 密码或 Access Token |

### 服务器部署

| Secret | 用途 |
|---|---|
| `SERVER_HOST` | 目标服务器地址 |
| `SERVER_PORT` | SSH 端口，可选，默认 `22` |
| `SERVER_USERNAME` | SSH 登录用户 |
| `SERVER_PASSWORD` | SSH 密码，可选 |
| `SERVER_SSH_KEY` | SSH 私钥，可选，和密码二选一即可 |
| `SERVER_APP_DIR` | 服务器部署目录，可选，默认 `/root/PersonalSpace/AgentProject` |

## 服务器端前置条件

目标服务器至少需要满足：

- 已安装 Docker
- 已安装 Docker Compose
- 部署目录下存在可用的 `.env`
- SSH 用户有权限执行 `docker compose`

## 当前设计说明

- `CI` 与 `CD` 分离，避免 PR 阶段就触发部署动作
- `desktop` 在 CI 只做 `renderer` 构建，减少常规校验耗时
- 真正的 Windows 安装包构建放到 `CD`
- 服务器部署采用“上传当前仓库源码 + 远端 compose 构建”，不依赖服务器自行 `git pull`

## 已知限制

- 如果服务器 `.env` 缺失，`deploy-server` 会主动失败
- 如果未配置 Docker Hub 或服务器 Secrets，对应 `CD` Job 会自动跳过
- 桌面安装包构建依赖 GitHub Windows Runner，构建时间会明显长于 CI

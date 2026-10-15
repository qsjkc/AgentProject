# AgentProject CI/CD 说明

## 目标

本文档描述仓库中的 GitHub Actions 自动化流程。历史远端结果见 `P1L-部署验收记录.md`；本次修改是否通过以对应提交的 Actions 运行记录为准。覆盖：

- `CI`：后端测试、PostgreSQL 迁移恢复检查、前端检查、桌面 renderer 与 Windows Electron 检查
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
pytest -q -p no:cacheprovider tests
python scripts/verify_postgres_release.py --report ../P1L-postgres-verification.json
```

说明：

- `backend/tests/conftest.py` 在收集应用前统一隔离环境：使用本次独立临时数据库、上传、下载、Chroma 和日志目录，禁用外部服务与网络访问，不读取开发 `.env`
- 使用 `-p no:cacheprovider` 避免 CI 写入 pytest cache
- PostgreSQL 检查自行创建并销毁无宿主挂载的本地容器；使用合成旧版本数据，不连接业务数据库。报告上传为 `postgres-release-verification`。

### 2. Frontend Checks

- Runner：`ubuntu-latest`
- Node.js：`20`
- 工作目录：`frontend/`
- 关键命令：

```bash
npm ci
npm run test
npm run lint
npm run build
```

### 3. Agent Server Tests

- Runner: `ubuntu-latest`
- Python: `3.11`
- Working directory: `agent-server/`
- Key commands:
```bash
python -m pip install --upgrade pip
pip install -r requirements.txt
pytest -q -p no:cacheprovider
```

### 4. Desktop Renderer Build

- Runner：`ubuntu-latest`
- Node.js：`20`
- 工作目录：`desktop/`
- 关键命令：

```bash
npm ci
npm run test
npm run build:renderer
```

说明：

- 此 Linux job 检查 renderer 构建；Windows job 检查 Electron 行为。
- NSIS 安装包构建仍放到 `CD`。

### 5. Windows Electron E2E

- Runner：`windows-latest`；Node.js：`22`；工作目录：`desktop/`。
- 依次运行 `npm ci`、`npm run test:e2e:runner`、`npm run build:renderer`、`npm run test:e2e`、`npm run pack`、`npm run test:packaged`。
- 场景集使用本机 stub 服务，包含新用户主链、权限续租、重载、账号切换、销毁重建、ACK 拒绝/超时和快捷聊天；场景数与覆盖细节以本次报告为准。
- packaged smoke 运行 `win-unpacked/Detachym.exe`，检查三个 renderer、E2E 控制关闭、登录与聊天、重启恢复和退出登录持久化。
- `desktop/artifacts/e2e/` 上传为 `desktop-e2e`，保存七天；不等于 NSIS 安装、真实服务或睡眠唤醒验收。

## CD 流程

### 触发方式

1. `CI` 在 `main` 分支成功完成后自动触发
2. 手动触发 `workflow_dispatch`，`ref` 只能为 `main`，执行工作流的分支也必须为 `main`

两种入口都锁定当前 `main` 的完整提交 SHA。自动入口要求成功的 CI 来自该 SHA 的 `main` push 或手动 CI；旧 SHA 的成功 CI 不会部署更新后的 `main`。手动入口会查询当前 SHA 的成功 CI，未通过时停止。构建结束、首次远端变更之前再次核对 `main`，发生移动时等待新提交的 CI。

合并 PR 后等待 `CI` → `CD` 即可。仅在需要重新执行且没有同批自动部署时手动运行：

```bash
gh workflow run cd.yml --ref main -f ref=main
gh run list --workflow cd.yml --branch main
gh run watch <run-id> --exit-status
```

`CD` 使用固定 `cd-main` 并发组排队，后续运行不会取消正在切换服务的运行。

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
- 若未配置服务器主机、用户名和 SSH 私钥，则 `deploy-server` 跳过；仅配置密码会明确失败，原生 SSH 不支持密码登录

### 2. Desktop Installer

- Runner：`windows-latest`
- 工作目录：`desktop/`
- 关键命令：

```powershell
npm ci
npm run build
```

产物：

- `desktop/dist/releases/Detachym-<version>-x64.exe`，版本读取 `desktop/package.json`
- `desktop/dist/releases/desktop-release.json`，包含版本、文件名、字节数、SHA-256 和完整 `sourceCommit`

构建步骤要求输出目录只有一个 EXE，名称与包版本相符，并核对 checkout 的精确 SHA。`deploy/verify_desktop_artifact.py` 使用标准库实现清单生成与验证。

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
- `SERVER_SSH_KEY`

则会执行服务器部署。

当前部署方式说明：

- 不再使用 `appleboy/ssh-action` / `appleboy/scp-action`
- 改为在 runner 内写入私钥，并使用原生 `ssh` / `scp`
- 先解析并清洗部署目标，再生成统一的 SSH config 别名 `deploy-target`

执行顺序：

1. 等待同一次 CD 的 `desktop-installer` 成功，下载其安装包 artifact
2. 写入 `~/.ssh/id_ed25519`
3. 解析部署目标
4. 创建远端目录
5. 检查线上桌面版本与 Alembic revision，阻止应用降级或目标缺失线上迁移
6. 验证 artifact 的唯一 EXE、版本、字节数、SHA-256 和源提交，再上传应用源码及暂存安装包
7. 服务端再核对安装包 SHA-256 与大小后原子改名；已存在的同名包必须具有相同哈希，避免覆盖已有版本。保留原 `.env` 和 `data/`，仅更新两个 `DESKTOP_RELEASE_*` 键，并保存原发布键元数据；原有本地 Agent 地址修正逻辑继续保留
8. 在服务器执行主服务及 `agent-server/` 的启动：

```bash
docker compose up -d --build --remove-orphans
docker compose ps
```

9. 检查后端与 Agent 就绪，再从 runner 检查公网 HTTPS readiness、版本/文件名/可下载状态和安装包 HEAD `Content-Length`：

```bash
python deploy/verify_desktop_artifact.py --directory desktop-release --package desktop/package.json \
  --source-commit <main-sha> --manifest desktop-release/desktop-release.json --verify \
  --public-base-url https://detachym.top
```

公网 origin 优先使用服务端 `WEB_APP_URL`，而非把 SSH 的 IP 当作 TLS 域名。全部检查成功后，服务器才将本次清单写为 `.deployed-release.json`；`server-release-verification` artifact 保留安装包清单、部署前版本检查与公网检查结果。公网 HEAD 只核对可访问性与体积，不能替代公网完整下载 SHA-256 或 Windows 安装验收。

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
| `SERVER_PASSWORD` | 不支持；仅配置密码时部署会失败 |
| `SERVER_SSH_KEY` | SSH 私钥全文，服务器部署必需 |
| `SERVER_APP_DIR` | 部署目录，可选，默认 `/root/PersonalSpace/AgentProject` |

CD 保留服务器已有 `.env`，不再使用 `APP_ENV_FILE` Secret 覆盖生产配置。运行密钥应在服务器配置，日志和发布清单不记录密钥。

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

### 部署前版本检查

CD 在上传源码和切换版本之前，读取正在运行的后端版本及数据库 Alembic revision，然后运行 `deploy/verify_release_transition.py`。目标桌面版本比线上旧、目标迁移目录不包含线上 revision，或无法确认线上状态时，部署会停止。

这用于阻止将旧 PR 合入主分支后，自动部署覆盖更新的线上版本。它不执行数据库降级，也不代替备份和回退方案。首次安装没有运行中的后端时，应使用初始化部署流程；恢复或回退应按对应版本的备份方案单独执行。

检查器测试：`python -m unittest discover -s deploy -p "test_*.py"`。

当前 CD 不自动备份或回滚数据库。`.release-state-before-<sha>.env` 仅保存两个旧发布键，不能视为完整运行配置或数据库备份。需要回退时使用对应版本的应用、数据库及配置备份；部署失败不会自动执行 Alembic downgrade。

### Windows 真实后端验收

Windows CI 在 Electron 场景集和打包 smoke 之后运行 `desktop/` 下的 `npm run test:packaged:real-backend`。该命令启动实际打包程序及真实 FastAPI 服务，数据仅存于本次独立 TEMP SQLite 数据库，使用两个合成账号，不连接生产数据库、不发送邮件、不调用模型或 RTC。

覆盖登录、选小猪、关系读取、互动、一分钟提醒自然送达和手动完成、重启恢复、后端服务中断重连、快捷聊天创建带中文分钟的重复提醒、账号隔离和退出持久化。结束后清理专属进程和临时数据；报告及失败截图保存在 `desktop/artifacts/e2e/real-backend-*/`。

此检查不代表 NSIS 安装卸载、桌面连接公网后端、双桌面同时运行或系统睡眠/跨日验收。

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
- 版本接口返回的安装包 URL（与同次构建的清单核对）

## 当前结论

历史部署记录见 `P1L-部署验收记录.md`；新加入的 main SHA 门禁、安装包传递及公网检查须以本次 Actions 运行记录作为部署证据。后续可继续增强：

1. 将当前“上传源码到服务器再构建”逐步演进为“镜像优先部署”（镜像已具备版本号和 SHA tag）
2. 若服务器网络环境稳定，再考虑恢复更严格的 host key 校验策略

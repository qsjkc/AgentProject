# AgentProject Git 部署说明

## 目标

本文档描述基于 GitHub 仓库和 GitHub Actions 的当前部署方式。

当前仓库地址：

```text
https://github.com/qsjkc/AgentProject.git
```

当前推荐发布分支：

```text
main
```

## 当前发布流程

### 1. 本地提交代码

```bash
git status
git add .
git commit -m "your message"
git push origin main
```

### 2. GitHub 自动执行 CI

触发：

- `push` 到 `main`
- `push` 到 `develop`
- 对 `main` 发起 PR

检查内容：

- 后端测试
- 前端 lint + build
- 桌面端 renderer build

### 3. GitHub 自动执行 CD

当 `CI` 在 `main` 分支成功后：

- 构建 Windows 安装包
- 可选推送 Docker 镜像
- 可选部署到服务器

## 手动触发 CD

如果你想手动重跑：

1. 打开 GitHub 仓库 `Actions`
2. 选择 `CD`
3. 点击 `Run workflow`
4. `ref` 选 `main` 或指定提交

## 需要的 Secrets

### 服务器部署

| Secret | 说明 |
|---|---|
| `SERVER_HOST` | 服务器地址，建议纯 IP 或域名 |
| `SERVER_PORT` | SSH 端口，默认 `22` |
| `SERVER_USERNAME` | SSH 登录用户 |
| `SERVER_SSH_KEY` | SSH 私钥全文 |
| `SERVER_PASSWORD` | 可选，不用私钥时才需要 |
| `SERVER_APP_DIR` | 部署目录，默认 `/root/PersonalSpace/AgentProject` |

### Docker 镜像发布

| Secret | 说明 |
|---|---|
| `DOCKER_USERNAME` | Docker Hub 用户名 |
| `DOCKER_PASSWORD` | Docker Hub Token 或密码 |

## 为什么当前不用 appleboy

此前部署链路曾遇到以下问题：

- SSH 认证异常不够透明
- `SERVER_PORT` / `SERVER_HOST` 的异常输入很难定位
- GitHub Actions 侧的错误信息不够接近底层 `ssh/scp`

当前已经改为：

- 在 runner 内写入私钥
- 生成统一的 SSH config
- 使用原生 `ssh` / `scp`

好处：

- 日志更直接
- 问题更容易定位
- 跟本机调试路径一致

## 当前 deploy-server 的真实步骤

1. 下载桌面安装包 artifact
2. 写入 `~/.ssh/id_ed25519`
3. 解析并清洗：
   - `SERVER_HOST`
   - `SERVER_PORT`
   - `SERVER_USERNAME`
   - `SERVER_APP_DIR`
4. 生成 SSH 别名 `deploy-target`
5. 创建远端目录
6. 上传源码压缩包
7. 上传桌面安装包
8. 在服务器运行：

```bash
docker compose up -d --build --remove-orphans
docker compose ps
```

9. 执行部署后检查：

```bash
python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:5000/health/ready'); urllib.request.urlopen('http://127.0.0.1:5000/api/v1/public/version/win-x64')"
```

## 服务器变量容错规则

当前 workflow 会自动清洗：

- `ssh://47.118.23.188:22`
- `http://detachym.top`
- `root@47.118.23.188`
- `47.118.23.188:22`

但仍建议直接使用：

```text
SERVER_HOST=47.118.23.188
SERVER_PORT=22
SERVER_USERNAME=root
SERVER_APP_DIR=/root/PersonalSpace/AgentProject
```

## 源码上传策略

为了避免远端 Docker 构建被本机依赖污染，当前上传源码时会排除：

- `frontend/node_modules`
- `frontend/dist`
- `frontend/.vite`
- `backend/venv`
- `backend/__pycache__`
- `backend/**/*.pyc`

并在服务器解包前清理：

- `frontend/node_modules`
- `frontend/dist`
- `frontend/.vite`
- `backend/venv`

## 已解决的典型问题

### 1. `unable to authenticate`

原因：

- Secret 中私钥不对
- 服务器未接受对应公钥

处理：

- 先在本机使用同一把私钥验证 `ssh -o IdentitiesOnly=yes`

### 2. `Bad port ''`

原因：

- 端口变量在 workflow 中被解析为空

处理：

- `preflight` 已加入端口清洗
- `deploy-server` 内部再次做端口兜底

### 3. `hostname contains invalid characters`

原因：

- `SERVER_HOST` 中夹带协议头、路径、用户名或端口格式

处理：

- workflow 已做标准化清洗

### 4. `sh: tsc: Permission denied`

原因：

- Windows 下 `frontend/node_modules` 污染了服务器 Docker build

处理：

- `.dockerignore`
- 上传时排除本机依赖目录
- 远端解包前先清理
- `deploy/Dockerfile.nginx` 内强制 `rm -rf node_modules && npm ci && npm run build`

## 推荐操作习惯

1. 改完代码先看本地验证是否通过
2. 推到 `main` 后观察 `CI`
3. `CI` 成功后再看 `CD`
4. 若 `CD` 失败，优先看失败步骤的完整日志，而不是只看摘要
5. 先解决当前步骤的根因，再继续下一步

## 当前结论

截至当前版本，基于 GitHub 的自动化部署链路已经跑通。后续若继续演进，优先建议：

1. 为镜像发布增加版本号 tag
2. 将源码上传式部署逐步切换为镜像优先部署
3. 增加服务器部署成功后的接口探测告警和回滚策略

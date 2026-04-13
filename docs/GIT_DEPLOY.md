# 云端同步与部署手册

这份手册对应当前这版项目，已经包含以下变更：

- Web 前端整体视觉升级，中文优先
- 注册后自动登录并跳转到账户中心
- Root Error Boundary，避免注册后空白页
- 桌宠默认简体中文，支持中英切换
- 安装器支持中英双语并显示语言选择
- 桌宠透明背景、可拖动、支持气泡和状态切换

## 1. 本地代码已完成的验证

本地已经验证过：

- `frontend`: `npm.cmd run build`
- `desktop`: `npm.cmd run build`
- `backend`: `.\venv\Scripts\python.exe -m pytest`

说明：

- `backend/pytest` 现在已通过 `pytest.ini` 忽略异常 ACL 的 `pytest-cache-files-*` 目录。
- `desktop` 打包成功后，最新安装包位于 `desktop/dist/releases/DetachymAgentPet1.0.exe`

## 2. 本地推送到 GitHub

在项目根目录执行：

```bash
git status
git add .
git commit -m "Refine desktop pet interactions and redesign web frontend"
git push origin main
```

如果你只想确认远端地址：

```bash
git remote -v
```

当前仓库远端应为：

```text
https://github.com/qsjkc/AgentProject.git
```

## 3. 云服务器首次准备

确保服务器已安装：

- `git`
- `docker`
- `docker compose`

如果是 CentOS / Rocky / AlmaLinux 一类环境，可参考：

```bash
dnf install -y dnf-plugins-core
dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin git
systemctl enable docker
systemctl start docker
```

## 4. 云端首次拉取项目

```bash
cd /root
mkdir -p PersonalSpace
cd PersonalSpace
git clone https://github.com/qsjkc/AgentProject.git AgentProject
cd AgentProject
```

如果服务器上已经有项目，只需要：

```bash
cd /root/PersonalSpace/AgentProject
git pull origin main
```

## 5. 配置生产环境变量

复制模板：

```bash
cp .env.example .env
```

编辑配置：

```bash
vim .env
```

至少检查这些配置：

- `SECRET_KEY`
- `ZHIPU_API_KEY`
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_USER`
- `SMTP_PASSWORD`
- `INITIAL_ADMIN_USERNAME`
- `INITIAL_ADMIN_EMAIL`
- `INITIAL_ADMIN_PASSWORD`
- `WEB_APP_URL`
- `VITE_API_BASE_URL`
- `API_ORIGINS`
- `DESKTOP_RELEASE_VERSION`
- `DESKTOP_RELEASE_FILE`

推荐示例：

```env
WEB_APP_URL=http://detachym.top
VITE_API_BASE_URL=http://detachym.top/api/v1
API_ORIGINS=http://detachym.top,http://47.118.23.188,http://localhost,http://127.0.0.1,http://localhost:5173,http://127.0.0.1:5173,null
DESKTOP_RELEASE_VERSION=DetachymAgentPet1.0
DESKTOP_RELEASE_FILE=DetachymAgentPet1.0.exe
```

注意：

- 不要把真实 `.env` 提交到 GitHub
- `INITIAL_ADMIN_PASSWORD` 不能继续使用示例密码
- `API_ORIGINS` 现在是逗号分隔格式，直接照模板填即可

## 6. 准备运行目录

```bash
mkdir -p data/postgres
mkdir -p data/uploads
mkdir -p data/chroma
mkdir -p data/downloads
mkdir -p logs
```

## 7. 上传桌面安装包

把本地这个文件上传到服务器：

```text
desktop/dist/releases/DetachymAgentPet1.0.exe
```

目标路径：

```text
/root/PersonalSpace/AgentProject/data/downloads/DetachymAgentPet1.0.exe
```

上传后，对外下载地址就是：

```text
http://detachym.top/download/DetachymAgentPet1.0.exe
```

公开版本接口：

```text
http://detachym.top/api/v1/public/version/win-x64
```

## 8. 启动或更新服务

在项目根目录执行：

```bash
cd /root/PersonalSpace/AgentProject
docker compose up -d --build
```

查看状态：

```bash
docker compose ps
docker compose logs -f backend
docker compose logs -f nginx
```

如果只是更新代码，仍然用同一条命令：

```bash
docker compose up -d --build
```

## 9. 上线后验收

先检查本机服务：

```bash
curl http://127.0.0.1/health
curl http://127.0.0.1/api/v1/public/version/win-x64
```

再检查公网页面：

- `http://detachym.top`
- `http://detachym.top/register`
- `http://detachym.top/login`
- `http://detachym.top/account`
- `http://detachym.top/admin`
- `http://detachym.top/health`
- `http://detachym.top/api/v1/public/version/win-x64`
- `http://detachym.top/download/DetachymAgentPet1.0.exe`

人工重点验收：

- 首页、登录页、注册页和后台页面样式是否为新版高级感界面
- 注册能收到验证码
- 注册完成后能自动进入 `/account`
- 普通用户能正常登录和修改偏好
- 管理员能正常进入 `/admin`
- 下载页能拿到最新安装包
- 安装器默认中文，并支持中英切换
- 桌宠安装后可拖动
- 单击桌宠能出现气泡或快捷聊天反馈
- 双击桌宠能打开主面板
- 桌宠背景透明，不再是白色方块

## 10. 常用维护命令

重新构建并启动：

```bash
cd /root/PersonalSpace/AgentProject
docker compose up -d --build
```

停止服务：

```bash
cd /root/PersonalSpace/AgentProject
docker compose down
```

查看后端日志：

```bash
cd /root/PersonalSpace/AgentProject
docker compose logs -f backend
```

查看 Nginx 日志：

```bash
cd /root/PersonalSpace/AgentProject
docker compose logs -f nginx
```

查看最近提交：

```bash
cd /root/PersonalSpace/AgentProject
git log --oneline -5
```

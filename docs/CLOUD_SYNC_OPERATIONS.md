# Detachym 云端同步操作手册

本文档用于把本地 `D:\PersonalSpace\AgentProject` 的最新版本同步到云端服务器，并完成安装包发布。

适用环境：
- 本地代码仓库：`D:\PersonalSpace\AgentProject`
- GitHub 仓库：`https://github.com/qsjkc/AgentProject`
- 云端部署目录：`/root/PersonalSpace/AgentProject`
- 域名：`detachym.top`
- 桌面安装包名称：`DetachymAgentPet1.0.exe`

## 1. 本地同步前检查

在本地 PowerShell 执行：

```powershell
cd D:\PersonalSpace\AgentProject
git status
git pull --rebase origin main
```

确认以下文件已经存在：

- 代码仓库：`D:\PersonalSpace\AgentProject`
- 桌面端安装包：
  `D:\PersonalSpace\AgentProject\desktop\dist\releases\DetachymAgentPet1.0.exe`
- 下载目录副本：
  `D:\PersonalSpace\AgentProject\backend\data\downloads\DetachymAgentPet1.0.exe`

如果安装包不存在，先重新打包：

```powershell
cd D:\PersonalSpace\AgentProject\desktop
npm.cmd run build
```

## 2. 推送代码到 GitHub

如果本地有新改动，先提交：

```powershell
cd D:\PersonalSpace\AgentProject
git add backend desktop frontend .gitignore
git commit -m "Describe your change"
git push origin main
```

不建议提交这些内容：

- `.env`
- `backend/.env`
- `Mry/`
- `runtime-logs/`
- `data/`

## 3. 登录云端服务器

在本地 PowerShell 执行：

```powershell
ssh root@47.118.23.188
```

登录后先进入项目目录：

```bash
cd /root/PersonalSpace/AgentProject
pwd
```

预期输出应为：

```text
/root/PersonalSpace/AgentProject
```

## 4. 云端拉取最新代码

执行：

```bash
cd /root/PersonalSpace/AgentProject
git fetch origin
git reset --hard origin/main
```

如果你不想使用 `reset --hard`，也可以用：

```bash
cd /root/PersonalSpace/AgentProject
git pull origin main
```

适用建议：
- 云端没有本地修改时，`git reset --hard origin/main` 更干净
- 云端可能存在临时修改时，优先 `git pull origin main`

## 5. 检查和维护云端环境变量

项目根目录使用：

```text
/root/PersonalSpace/AgentProject/.env
```

查看关键字段是否正确：

```bash
cd /root/PersonalSpace/AgentProject
grep -E "WEB_APP_URL|VITE_API_BASE_URL|DESKTOP_RELEASE_VERSION|DESKTOP_RELEASE_FILE|INITIAL_ADMIN_PASSWORD" .env
```

建议至少确认这些值：

```env
WEB_APP_URL=http://detachym.top
VITE_API_BASE_URL=http://detachym.top/api/v1
DESKTOP_RELEASE_VERSION=DetachymAgentPet1.0
DESKTOP_RELEASE_FILE=DetachymAgentPet1.0.exe
INITIAL_ADMIN_PASSWORD=ChangeThisPassword123!
```

如果要编辑：

```bash
vi /root/PersonalSpace/AgentProject/.env
```

## 6. 上传最新版安装包到云端

本地源文件：

```text
D:\PersonalSpace\AgentProject\desktop\dist\releases\DetachymAgentPet1.0.exe
```

上传命令：

```powershell
scp "D:\PersonalSpace\AgentProject\desktop\dist\releases\DetachymAgentPet1.0.exe" root@47.118.23.188:/root/PersonalSpace/AgentProject/data/downloads/DetachymAgentPet1.0.exe
```

云端验证文件：

```bash
ls -lh /root/PersonalSpace/AgentProject/data/downloads/
```

预期目标文件：

```text
/root/PersonalSpace/AgentProject/data/downloads/DetachymAgentPet1.0.exe
```

## 7. 重建并启动云端服务

在云端执行：

```bash
cd /root/PersonalSpace/AgentProject
docker compose up -d --build
```

查看容器状态：

```bash
docker compose ps
```

查看后端日志：

```bash
docker compose logs -f backend
```

查看 Nginx 日志：

```bash
docker compose logs -f nginx
```

## 8. 云端上线验证

先在云端本机验证：

```bash
curl http://127.0.0.1/health
curl http://127.0.0.1/api/v1/public/version/win-x64
```

再验证公网入口：

```bash
curl http://detachym.top/health
curl http://detachym.top/api/v1/public/version/win-x64
```

浏览器人工验证页面：

- `http://detachym.top`
- `http://detachym.top/login`
- `http://detachym.top/register`
- `http://detachym.top/account`
- `http://detachym.top/admin`
- `http://detachym.top/download`
- `http://detachym.top/download/DetachymAgentPet1.0.exe`

接口预期：
- `/health` 返回 `{"status":"ok"}` 或等价健康响应
- `/api/v1/public/version/win-x64` 返回 `available: true`
- 下载链接返回安装包文件

## 9. 桌面端发布验证

验证点：

1. 下载页展示版本号和文件名
2. 安装包可正常下载
3. 安装后主窗口为中文标题
4. 窗口顶部不再显示英文 `File / Edit / View / Window / Help`
5. 桌宠、快捷聊天、主面板能正常打开
6. 首次登录能连接云端 API

## 10. 常见故障排查

### 10.1 Git 拉取失败

检查：

```bash
cd /root/PersonalSpace/AgentProject
git remote -v
git status
```

如果云端有脏改动且不需要保留：

```bash
git reset --hard origin/main
```

### 10.2 Docker 构建失败

执行：

```bash
docker compose build --no-cache
docker compose up -d
```

如果镜像源异常，检查 Dockerfile 中的镜像源配置是否与你当前云端一致。

### 10.3 页面正常但安装包还是旧版

说明代码已经更新，但 `data/downloads/DetachymAgentPet1.0.exe` 没有覆盖成功。

重新上传：

```powershell
scp "D:\PersonalSpace\AgentProject\desktop\dist\releases\DetachymAgentPet1.0.exe" root@47.118.23.188:/root/PersonalSpace/AgentProject/data/downloads/DetachymAgentPet1.0.exe
```

### 10.4 下载包安装后仍异常

优先检查：
- 云端下载目录中的文件时间是否最新
- 本地是否重新下载安装了新包
- 桌面端连接的 API 地址是否正确

## 11. 推荐上线顺序

建议固定按下面顺序执行：

1. 本地代码验证通过
2. 本地打包生成最新 `.exe`
3. 推送 GitHub
4. 云端拉取最新代码
5. 上传最新 `.exe`
6. `docker compose up -d --build`
7. 健康检查
8. 公网页面和下载验证
9. 桌面端安装验证

## 12. 当前版本记录

当前本地已确认：
- 桌面安装包路径：
  `D:\PersonalSpace\AgentProject\desktop\dist\releases\DetachymAgentPet1.0.exe`
- 本地下载副本：
  `D:\PersonalSpace\AgentProject\backend\data\downloads\DetachymAgentPet1.0.exe`
- Git 提交：
  `df1f65b`

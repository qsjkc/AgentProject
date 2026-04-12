# Detachym Agent Pet

Detachym Agent Pet 是一个桌宠桌面端 + Web 门户 + FastAPI 后端的一体化项目。

## 目录结构

- `backend/`：FastAPI 后端、鉴权、管理后台接口、RAG 与文件上传
- `frontend/`：React Web 门户，包含首页、登录、注册、账户中心、下载页、管理页
- `desktop/`：Electron 桌面端，包含桌宠窗口、快捷聊天和主面板
- `deploy/`：Nginx 与 Docker 部署文件
- `docs/`：接口与部署说明

## 本地开发

后端：

```powershell
cd backend
python -m venv venv
.\venv\Scripts\activate
pip install -r requirements.txt
copy ..\.env.example .env
python run.py
```

前端：

```powershell
cd frontend
npm install
npm run dev
```

桌面端：

```powershell
cd desktop
npm install
npm run dev
```

## 生产部署

建议使用项目根目录的 `docker-compose.yml` 进行单机部署。

```bash
cp .env.example .env
docker compose up -d --build
```

完整步骤见：

- `docs/DEPLOYMENT.md`
- `docs/GIT_DEPLOY.md`

## 发布约定

- Web 域名：`detachym.top`
- 桌面安装包文件名：`DetachymAgentPet1.0.exe`
- 安装包发布目录：`data/downloads/`

## 安全说明

- 不要把真实 `.env`、邮箱授权码、GLM Key、管理员密码提交到 GitHub
- `Mry/`、`runtime-logs/`、`data/` 都应视为本地私有内容

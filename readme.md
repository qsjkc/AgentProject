# Detachym Agent Pet

Detachym Agent Pet 是一个桌宠桌面端 + Web 门户 + FastAPI 后端的一体化项目。

桌面端的小猪、猫咪和小狗均提供聊天、提醒、照顾、主动陪伴、成长换装、首次引导，以及“陪我专注”和“上周的我们”。专注支持 15/25/45 分钟、暂停与继续，关闭主面板仍会计时；记录按账号、宠物和服务地址保存在本机。Web 门户提供产品介绍、账号管理与实际发布版本的下载入口。

新账号默认遇见小猪，已有宠物选择保持不变。空白对话提供三个轻量开场建议，选择后填入草稿，由用户决定何时发送；登录支持明确字段标签、键盘操作和失败后的直接重试。

猫狗各有独立的连续动作图集，覆盖待机、走动、跳跃、开心、疑惑、提醒、睡觉、摸摸、进食和清洁，每个基础动作 6 帧；小猪保留已有逐帧动画。配饰图集共用，佩戴位置分别配置。三种宠物的关系、装扮解锁和首次引导分别记录，已有高等级猫狗会按等级补齐装扮，但不会补播历史升级回礼。下载页以线上发布版本为准。

提醒由主进程按最近截止时间唤醒并再次核对服务端状态，隐藏桌宠仍可处理到期事项。桌宠尊重系统减少动态效果设置，隐藏时暂停视觉动画。知识库支持 `.txt`、`.md`、`.pdf`，上传失败记录可在列表中删除后重试，大文本索引及删除按实际向量库批次上限处理。

主面板与快捷聊天都可说“十分钟后提醒我喝水”“半小时后叫我休息”或“每周一九点提醒我开会”。相对时间使用实际经过的分钟或小时，范围为 1 分钟到 168 小时；支持中文整数和“一个半小时”等表达，不猜测小数或多个冲突时间。时间、星期或事项不完整时保留草稿并提示修改，保存失败也能重试。主面板的“待提醒”列出尚未提醒的一次性事项，可按设备本地时间改期或取消；重复提醒仍由系列面板管理。

## 目录结构

- `backend/`：FastAPI 后端、鉴权、管理后台接口、RAG 与文件上传
- `agent-server/`：RTC 语音的独立 Agent 服务，调用主后端内部工具
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

当前模块边界、存储和关键数据流见 [架构说明](docs/ARCHITECTURE.md)。

## 本地验证

在对应目录执行：

| 目录 | 命令 | 覆盖范围 |
| --- | --- | --- |
| `frontend/` | `npm.cmd test`、`npm.cmd run lint`、`npm.cmd run build` | 网页逻辑、代码检查与生产构建 |
| `backend/` | `venv\Scripts\python.exe -m pytest -q` | API、提醒投递与数据库会话 |
| `desktop/` | `npm.cmd test`、`npm.cmd run build:renderer` | 桌面逻辑与渲染器构建 |
| `desktop/` | `npm.cmd run test:e2e` | 真实 Electron 窗口，使用本地模拟接口 |
| `desktop/` | `npm.cmd run test:real-backend` | 实际网页新账号注册、SMTP STARTTLS/AUTH 收件、真实 Electron 三宠流程，全部使用临时 SQLite 和本地 SMTP 收件器 |
| `desktop/` | `npm.cmd run test:packaged:real-backend` | 同一流程运行打包后的程序，先执行 `npm.cmd run pack` |

真实后端验收先在 `frontend/` 执行 `npm.cmd run build`，要求 Windows Microsoft Edge 和 `backend/venv`。账号由网页注册创建，验证码从本地 SMTP 收件器读取；自然等待五分钟验证过期拒绝，不预置账号、不改数据库时间。此检查不证明外部邮箱实际收到邮件。

发布后可用 `backend/venv/Scripts/python.exe deploy/verify_live_pet_release.py --base-url https://your-domain --expected-version <version> --credentials-env .env --report <report.json>` 检查公开服务。脚本通过现有管理员账号创建两个临时账号，验证三宠成长、装扮、猫狗真实模型聊天和提醒，再删除本轮账号；它不替代邮箱注册验收。

桌面端到端验证需要已安装项目依赖和已构建渲染器；真实后端验证还需要 `backend/venv`。源码测试通过不代表安装包已重新构建或已完成线上验收。本轮功能、证据和未验证项见 [产品优化与验证记录](本轮产品优化与验证.md)。

后端 pytest 在收集测试前启用独立临时数据库、索引、文件和日志目录，忽略本地 `.env`，禁用外部凭据与后台任务，并阻止外网连接；外部 API 使用模拟传输。不要在测试模块里自行加载开发环境配置。应用正常启动仍默认读取 `.env`；需要指定配置文件时可设置 `DETACHYM_ENV_FILE`，空字符串表示不读取 dotenv。

## 发布约定

- Web 域名：`detachym.top`
- 桌面构建产物命名：`Detachym-${version}-${arch}.${ext}`，由 `desktop/package.json` 定义。
- 当前对外发布版本、文件名和可下载状态以 `/api/v1/public/version/win-x64` 为准；后端 `DESKTOP_RELEASE_VERSION`、`DESKTOP_RELEASE_FILE` 必须与实际发布文件一致。
- 安装包发布目录：`data/downloads/`

## 安全说明

- 不要把真实 `.env`、邮箱授权码、GLM Key、管理员密码提交到 GitHub
- `Mry/`、`runtime-logs/`、`data/` 都应视为本地私有内容

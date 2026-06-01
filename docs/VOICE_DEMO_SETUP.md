# 火山引擎 RTC 语音 Agent Demo 手动配置教程

这份文档只回答一个问题：**我作为项目拥有者，还需要手动做什么，才能把这套语音 Demo 跑起来并完成联调。**

## 1. 火山控制台需要准备什么

你需要先在火山引擎侧把语音 RTC 和第三方 Agent 出口准备好。

### 必备项

1. 开通或确认可用的 AI 音视频互动方案能力。
2. 获取 RTC `AppId`。
3. 获取 RTC `AppKey`。
4. 获取 OpenAPI `AK / SK`。
5. 确认 OpenAPI `Region`，默认通常是 `cn-north-1`，但要以你的控制台实际地域为准。
6. 准备一份可用的 `ASRConfig` JSON。
7. 准备一份可用的 `TTSConfig` JSON。
8. 准备第三方 LLM / Agent URL，也就是你部署出来的 `agent-server`：
   - `https://your-main-domain/agent/v1/chat/completions`
9. 确认火山侧 `StartVoiceChat / UpdateVoiceChat / StopVoiceChat` 使用的是新版 `2025-06-01` 接口。

### 必须遵守的边界

1. 不配置旧“实时对话式 AI”接口。
2. 不启用火山 Function Calling。
3. 不配置 `ServerMessageUrl`。
4. 不把 trace envelope 注入到 system prompt。

### 你要自己准备的 JSON

后端现在会直接读取环境变量里的以下 JSON：

- `VOLC_VOICE_CHAT_ASR_CONFIG_JSON`
- `VOLC_VOICE_CHAT_TTS_CONFIG_JSON`
- `VOLC_VOICE_CHAT_LLM_CONFIG_JSON`

其中：

- `ASRConfig` 和 `TTSConfig` 必须是真实可用的 JSON。
- `LLMConfig` 可选覆盖项默认是 `{}`，主 URL / API Key / ModelName 由独立环境变量提供。

## 2. 后端 `.env` 需要填什么

后端至少要填写这些变量：

```env
VOLC_AI_RTC_APP_ID=
VOLC_AI_RTC_APP_KEY=
VOLC_OPENAPI_AK=
VOLC_OPENAPI_SK=
VOLC_OPENAPI_REGION=
VOLC_AGENT_CHAT_COMPLETIONS_URL=
VOLC_AGENT_API_KEY=
VOLC_RTC_TOKEN_TTL_SECONDS=3600
BACKEND_INTERNAL_API_KEY=
```

### 每个字段填什么

- `VOLC_AI_RTC_APP_ID`
  - 来源：火山 RTC 控制台。
  - 用途：前端入房和后端 VoiceChat 控制面都依赖它。

- `VOLC_AI_RTC_APP_KEY`
  - 来源：火山 RTC 控制台。
  - 用途：后端生成 RTC token。

- `VOLC_OPENAPI_AK`
  - 来源：火山 OpenAPI 访问密钥。
  - 用途：后端调用 `StartVoiceChat / UpdateVoiceChat / StopVoiceChat`。

- `VOLC_OPENAPI_SK`
  - 来源：火山 OpenAPI 访问密钥。
  - 用途：同上。

- `VOLC_OPENAPI_REGION`
  - 来源：火山控制台实际地域。
  - 用途：后端 OpenAPI 请求签名与路由。

- `VOLC_AGENT_CHAT_COMPLETIONS_URL`
  - 来源：你部署出来的 `agent-server` 公网 HTTPS 地址。
  - 例子：`https://detachym.top/agent/v1/chat/completions`

- `VOLC_AGENT_API_KEY`
  - 来源：你自己定义的一段服务间 Bearer key。
  - 用途：火山 VoiceChat 调第三方 Agent URL 时带上的鉴权值。
  - 这必须与 `agent-server` 的 `AGENT_API_KEY` 一致。

- `VOLC_RTC_TOKEN_TTL_SECONDS`
  - 来源：你自己定义。
  - 用途：RTC token 有效期。默认 3600 秒。

- `BACKEND_INTERNAL_API_KEY`
  - 来源：你自己定义的一段内部服务 key。
  - 用途：只给 `agent-server -> backend` 的内部工具调用。
  - 绝对不要下发给浏览器。

### 后端还需要补的实际变量

为了让语音会话真正能启动，你还需要在后端 `.env` 里填写这些：

```env
VOLC_AGENT_MODEL_NAME=voice-agent-demo-v1
VOLC_VOICE_CHAT_ASR_CONFIG_JSON={}
VOLC_VOICE_CHAT_TTS_CONFIG_JSON={}
VOLC_VOICE_CHAT_LLM_CONFIG_JSON={}
VOLC_VOICE_CHAT_SYSTEM_PROMPT=
VOLC_SESSION_CLEANUP_INTERVAL_SECONDS=30
VOLC_SESSION_TOMBSTONE_SECONDS=300
```

其中最关键的是 `VOLC_VOICE_CHAT_ASR_CONFIG_JSON` 和 `VOLC_VOICE_CHAT_TTS_CONFIG_JSON`，这两个如果还是空对象，`POST /api/v1/rtc/voice-demo/session/{id}/start` 会失败。

## 3. agent-server `.env` 需要填什么

`agent-server/.env` 至少填写：

```env
AGENT_API_KEY=
AGENT_LOG_LEVEL=info
AGENT_FIRST_CHUNK_TIMEOUT_MS=8000
AGENT_TOTAL_TIMEOUT_MS=45000
AGENT_TOOL_TIMEOUT_MS=5000
BACKEND_BASE_URL=
BACKEND_FALLBACK_BASE_URL=http://backend:5000
BACKEND_INTERNAL_API_KEY=
```

### 对齐关系

- `AGENT_API_KEY`
  - 必须和后端 `VOLC_AGENT_API_KEY` 一致。
  - 也就是火山侧第三方 Agent 鉴权最终命中的那个 Bearer key。

- `BACKEND_INTERNAL_API_KEY`
  - 必须和后端 `BACKEND_INTERNAL_API_KEY` 一致。
  - 它只给 `agent-server` 调：
    - `/api/v1/tools/internal/weather`
    - `/api/v1/tools/internal/chat`
    - 以及后续你要放到内部工具面的接口

- `BACKEND_BASE_URL`
  - 填主站后端公网地址。
  - 例子：`https://app.example.com`
  - 如果 `agent-server` 和主项目后端在同一个 Docker 网络内，推荐填 `http://backend:5000`，这样工具调用不依赖公网 HTTPS 回环。

- `BACKEND_FALLBACK_BASE_URL`
  - 可选兜底地址。
  - Docker Compose 部署时建议保持 `http://backend:5000`。
  - 当 `BACKEND_BASE_URL` 指向公网域名但证书、DNS 或代理暂时不可用时，天气和平台状态工具会尝试这个内部地址。

## 4. 如何部署 agent-server

当前 `agent-server/` 是独立部署的，不并进仓库根 `docker-compose.yml`。

### Docker 构建

```bash
cd agent-server
docker compose up -d --build
```

### 公网代理要求

你还需要自己配 HTTPS 反向代理，例如 Nginx 或 Caddy，并保证公网可访问：

```text
https://your-main-domain/agent/v1/chat/completions
https://your-main-domain/agent/health
```

这两个地址至少要满足：

1. 外网可访问；
2. 有有效 HTTPS；
3. `/v1/chat/completions` 接受 `Authorization: Bearer <AGENT_API_KEY>`；
4. `stream=true` 时返回标准 SSE，并且最终有 `data: [DONE]`。

## 5. 如何启动主项目

### 后端

```powershell
cd backend
backend\venv\Scripts\python.exe -m pytest
backend\venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 5000
```

### 前端

根据当前仓库脚本，使用：

```powershell
cd frontend
npm install
npm.cmd run lint
npm.cmd run build
npm.cmd run dev
```

### agent-server

本地调试时可以直接跑：

```powershell
cd agent-server
python -m pip install -r requirements.txt
python -m pytest
python -m uvicorn app.main:app --reload --port 8000
```

## 6. 如何验收

按这个顺序做：

1. 启动后端。
2. 启动前端。
3. 部署并启动 `agent-server`。
4. 登录主站。
5. 进入账户页。
6. 点击 `AI 语音 Demo`。
7. 点击“连接”。
8. 授权麦克风。
9. 说“现在几点了”。
10. 说“今天天气怎么样”。
11. 说“平台现在正常吗”。
12. 点击“打断 AI”。
13. 点击“挂断”。
14. 刷新页面，确认不会残留异常状态。
15. 查看后端和 `agent-server` 日志。

你需要重点确认：

1. 浏览器成功入 RTC 房间；
2. 前端只订阅 `aiUserId` 的远端音频；
3. `interrupt` 能触发 `UpdateVoiceChat(Command=interrupt)`；
4. `stop` 重复调用不报错；
5. `agent-server` 的 SSE 最终有 `[DONE]`。

## 7. 常见问题

### 麦克风权限失败

- 检查浏览器是否拒绝了麦克风权限。
- 检查系统录音设备是否被别的应用独占。
- 前端页面要求在用户点击“连接”后触发权限申请。

### 非 HTTPS 无法使用

- 浏览器环境下，麦克风和 RTC 采集默认要求安全上下文。
- 只有 `localhost` / `127.0.0.1` 可以在本地例外使用。

### 听不到 AI 声音

- 检查前端是否成功订阅了 `aiUserId` 音频流。
- 检查 AI 用户是否真的发流。
- 检查浏览器是否拦截了自动播放。
- 检查火山侧 TTS 配置是否有效。
- 桌面端默认是 `text_only`，只有在主面板把桌面语音回复模式切到 `voice_and_text` 才会自动外放。

### 打断无效

- 确认前端调用的是 `/api/v1/rtc/voice-demo/session/{id}/interrupt`。
- 确认后端实际调用 `UpdateVoiceChat` 时 `Command=interrupt`。
- 确认当前 session 仍处于 `active`。

### 401 鉴权失败

- 主站前端调后端 RTC API 依赖现有登录 token。
- `agent-server` 依赖 `Authorization: Bearer <AGENT_API_KEY>`。
- 内部天气工具依赖 `X-Internal-Api-Key: <BACKEND_INTERNAL_API_KEY>`。
- 内部通用聊天工具也依赖同一个 `X-Internal-Api-Key`。

### Agent SSE 不返回 `[DONE]`

- 检查 `agent-server` 是否正常跑到了流尾。
- 检查反向代理是否截断了 SSE。
- 检查超时或异常时是否被代理层改写为 502 / 504。
- 当前实现会先发送一个 OpenAI-compatible 空 SSE chunk，慢工具不会再因为首包超时直接取消。

### 天气服务暂时不可用

- 先在服务器上测 `curl http://backend:5000/api/v1/tools/internal/weather -H "X-Internal-Api-Key: <同后端一致的 key>"`。
- 如果公网域名 HTTPS 还没配好，`agent-server/.env` 里的 `BACKEND_BASE_URL` 不要填 `https://detachym.top`，先填 Docker 内网地址 `http://backend:5000`。
- 如果内网地址可用但公网不可用，保留 `BACKEND_FALLBACK_BASE_URL=http://backend:5000`。
- 如果仍然失败，检查服务器是否能访问 Open-Meteo：`https://geocoding-api.open-meteo.com` 和 `https://api.open-meteo.com`。

### 很多普通问题无法回答

- 确认主后端的 LLM provider 已配置，例如 `ZHIPU_API_KEY`。
- 确认 `agent-server` 能通过内部 key 调到 `/api/v1/tools/internal/chat`。
- 这个通用聊天兜底不读取用户私有 RAG 文档；如果要做用户级 RAG，需要后续设计语音会话和用户身份绑定。

### 火山 `StartVoiceChat` 失败

- 检查 `VOLC_OPENAPI_AK/SK/REGION`。
- 检查 `VOLC_VOICE_CHAT_ASR_CONFIG_JSON`。
- 检查 `VOLC_VOICE_CHAT_TTS_CONFIG_JSON`。
- 检查 `VOLC_AGENT_CHAT_COMPLETIONS_URL` 是否公网可达且 HTTPS 可用。

### token 过期

- RTC token 由 `VOLC_RTC_TOKEN_TTL_SECONDS` 控制。
- 如果会话要长时间保活，需要更长 TTL 或引入 token 刷新机制。

### 后端多 worker 时内存 session store 不可靠

- 当前后端 RTC session store 是进程内存实现。
- 单机单 worker Demo 没问题。
- 多 worker 或多实例部署时需要换成 Redis 之类的共享状态存储。

## 8. CI/CD 补充

仓库当前已经补了 `agent-server` 的 CI/CD：

1. `CI` 会额外执行 `agent-server` 的 pytest。
2. `CD` 会把 `agent-server/` 一起上传到服务器。
3. `CD` 会在服务器上基于根 `.env` 自动生成 `agent-server/.env`。
4. `CD` 会以独立 compose 的方式启动 `agent-server`。
5. 主站 `nginx` 会把 `/agent/*` 反代到 `agent-server`。

如果你想让 CD 自动同步服务器 `.env`，还需要在 GitHub Secrets 中提供：

```text
APP_ENV_FILE
```

它的值就是服务器要使用的完整根 `.env` 文本。

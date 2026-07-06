# 火山 RTC 桌宠语音使用场景与稳定性处理

这份清单用于后续联调和排障，按真实使用路径列出可能场景、风险和当前代码处理方式。

## 桌面端入口

1. 未登录或登录过期
   - 表现：桌宠气泡提示重新登录，不再显示 `Could not validate credentials`。
   - 处理：桌面 voice API 遇到 401/403 会清理本地 token，并让桌宠退出语音态。

2. 服务地址未配置或后端不可达
   - 表现：主面板配置服务地址；语音态显示明确错误。
   - 处理：桌面端统一从 Electron store 读取 API base URL，请求失败不继续创建 RTC session。

3. 全局快捷键或单击桌宠进入语音态
   - 表现：按 `CommandOrControl+Alt+D` 或单击桌宠后进入 `voice_armed -> connecting -> ready`。
   - 处理：全局快捷键会先显示并聚焦桌宠，再复用现有进入语音态流程；重复触发不会创建多个 session，`connecting` 状态会忽略重复触发。

4. 按住 D 说话
   - 表现：`keydown event.code === KeyD` 进入 `listening`。
   - 处理：忽略 `event.repeat`，松开 D 后进入 `processing`。

5. 窗口失焦
   - 表现：如果正在听，先结束本轮输入；否则退出 UI 语音态。
   - 处理：清理按键状态，避免卡在 `listening`。

6. Esc 退出
   - 表现：立即回到 idle。
   - 处理：best-effort stop / leave / cleanup，重复 cleanup 不报错。

7. 麦克风权限失败或设备不可用
   - 表现：桌宠显示麦克风相关错误。
   - 处理：进入 RTC 前先 `getUserMedia({ audio: true })` 检查权限。

8. RTC SDK 不支持当前环境
   - 表现：桌宠显示当前环境不支持 RTC。
   - 处理：创建 session 前检查 `VERTC.isSupported()`。

9. AI 回复较长或工具较慢
   - 表现：桌宠保持等待/回复状态，不会因为 30 秒空闲计时误清理正在回复的 session。
   - 处理：收到远端音频流或字幕事件时刷新 RTC inactivity timer；回复气泡展示时间延长到 8 秒。

10. `text_only` 与 `voice_and_text`
    - 表现：桌面语音默认使用 `voice_and_text`，会显示文字并自动播放 AI 远端音频；切到 `text_only` 后只显示桌宠气泡文字。
    - 处理：RTC adapter 统一管理隐藏 audio sink 和远端音量。

## 字幕与打断

1. 收到 AI 字幕
   - 表现：增量字幕更新气泡，最终字幕落定为回复。
   - 处理：兼容 `text/content/message`、`isFinal/final/definite`、`userId/speakerId/uid/streamKey`。

2. 收到用户自己的字幕
   - 表现：不作为长期 AI 回复展示。
   - 处理：speaker 等于本地 `userId` 时忽略。

3. 字幕无法区分说话人
   - 表现：不把用户文本误当 AI 回复。
   - 处理：只接受 AI user 或非本地远端候选。

4. processing / replying 时单击桌宠
   - 表现：调用 interrupt，然后回 ready。
   - 处理：后端 interrupt 对 stopped / expired / missing session 返回 200 风格响应。

## Agent 与工具

1. 时间
   - 路由：包含“几点/时间/日期/星期/time/date”。
   - 处理：agent-server 本地返回服务器当前北京时间。

2. 天气
   - 路由：包含“天气/气温/温度/下雨/weather/temperature”等。
   - 处理：agent-server 调后端 `/api/v1/tools/internal/weather`，后端使用 Open-Meteo。

3. 天气连续追问
   - 场景：先问“北京天气怎么样”，再问“那上海呢”。
   - 处理：agent-server 读取最近用户消息，识别 follow-up 城市并继续走天气工具。

4. 平台状态
   - 路由：包含“平台/后端/系统/服务”并带状态类词。
   - 处理：agent-server 调 `/health/ready`。

5. 普通问题
   - 场景：不属于时间、天气、平台状态的问题。
   - 处理：agent-server 调主后端 `/api/v1/tools/internal/chat`，由项目现有 LLM provider 给简短语音化回答。

6. 工具失败
   - 表现：返回适合 TTS 播报的降级文本，不直接 500。
   - 处理：每个工具用 `asyncio.wait_for` 限时，失败转换为自然语言。

7. 首包慢
   - 表现：SSE 立即返回 OpenAI-compatible 空 chunk，慢工具继续执行。
   - 处理：首包超时不取消任务，后续结果仍会输出并以 `[DONE]` 结束。

8. agent 到后端公网不可达
   - 表现：天气/平台/通用聊天工具尝试 fallback 地址。
   - 处理：支持 `BACKEND_FALLBACK_BASE_URL=http://backend:5000`。

## 部署与配置

1. agent-server 独立部署
   - 使用 `agent-server/docker-compose.yml`，加入主项目 `agentproject-network`。

2. 火山第三方 Agent URL
   - 配置到公网 HTTPS：`https://detachym.top/agent/v1/chat/completions`。

3. 内部工具鉴权
   - 后端和 agent-server 的 `BACKEND_INTERNAL_API_KEY` 必须一致。
   - 该 key 只在服务端使用，不下发到浏览器或桌面端。

4. 通用聊天能力
   - 依赖主后端已有 `ZHIPU_API_KEY` 等 LLM provider 配置。
   - 如果 LLM provider 未配置，会返回“模型服务未配置”的降级内容。

## 已知限制

1. 内部通用聊天当前不绑定具体登录用户，因此不会读取某个用户的私有 RAG 文档。
2. 全局唤起键固定为 `CommandOrControl+Alt+D`，进入语音态后仍需要按住 D 完成本轮说话。
3. 多 worker 后端仍需要 Redis 等共享 session store，否则 RTC session 内存状态不能跨进程共享。
4. 语音自动播放仍受系统音频设备、Electron 权限和火山远端发流状态影响。

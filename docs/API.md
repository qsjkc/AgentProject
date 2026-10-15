# Detachym API 说明

## 基本信息

- Base URL：`/api/v1`
- 认证方式：`Authorization: Bearer <token>`

## 认证接口

通过仓库 Nginx 部署时，登录、注册、发送注册验证码、忘记密码和重置密码共享按来源 IP 的 `auth_limit`（平均每分钟 10 次，按接口允许 10 或 20 次突发）。超过限制返回 `429` 与 `Retry-After: 70`，建议停止请求至少 70 秒再试；同一 IP 的其他请求仍会占用共享额度。这是 Nginx 入口保护，直接连接后端会绕过它，应用目前没有每账号请求限流。

### 发送注册验证码

```http
POST /auth/send-verification-code
```

```json
{
  "email": "user@example.com"
}
```

### 注册

注册与重置密码使用 6 位数字验证码，有效期 5 分钟，到期即失效。成功的账号修改与验证码消费在同一数据库事务中完成，同一个验证码的并发请求至多成功一次；事务失败会回滚消费状态，仍在有效期内的验证码可以重试。

```http
POST /auth/register
```

```json
{
  "username": "demo",
  "email": "user@example.com",
  "password": "Password123!",
  "verification_code": "123456"
}
```

### 登录

```http
POST /auth/login
Content-Type: application/x-www-form-urlencoded
```

字段：

- `username`：用户名或邮箱
- `password`：密码

用户名与邮箱分别唯一；如果同一个输入命中两个账号，仅在密码唯一匹配其中一个时登录。零匹配或多匹配均返回原有 `401`，唯一匹配的停用账号返回 `403`，不会回退登录另一账号。后台新增或修改用户的双字段冲突返回 `400`，不会因命中两行而返回 `500`。

### 忘记密码

```http
POST /auth/forgot-password
```

```json
{
  "email": "user@example.com"
}
```

### 重置密码

```http
POST /auth/reset-password
```

```json
{
  "email": "user@example.com",
  "verification_code": "123456",
  "new_password": "NewPassword123!"
}
```

### 获取当前用户

```http
GET /auth/me
```

### 修改密码

```http
POST /auth/change-password
```

```json
{
  "current_password": "OldPassword123!",
  "new_password": "NewPassword123!"
}
```

## 用户偏好

### 获取偏好

```http
GET /users/me/preferences
```

### 更新偏好

```http
PUT /users/me/preferences
```

```json
{
  "pet_type": "pig",
  "quick_chat_enabled": true,
  "bubble_frequency": 120
}
```

`bubble_frequency` 单位为秒，范围为 30–3600。小猪的主动陪伴节奏由桌面“主动陪伴”设置控制；该频率用于猫狗气泡。`quick_chat_enabled` 为保留字段，当前网页不展示未生效的快捷聊天开关。

新建账号及缺失偏好的账号默认使用 `pet_type: "pig"`；已有猫、狗或小猪选择保持原值。`PUT` 只更新请求中显式提供的字段，省略字段保留存储值，空对象不重置偏好；以上字段不接受 `null`，传入时返回 `422`。

## 对话接口

两种对话接口仅在未提供 `session_id` 时新建会话。显式指定的会话不存在、已删除或不属于当前账号时返回 `404`，不会静默替换为新会话。

### 同步对话

```http
POST /chat/message
```

```json
{
  "message": "Hello",
  "session_id": 1,
  "use_rag": true
}
```

同步对话在模型未配置、调用失败或未产生有效内容时返回 `503`，`detail` 为可读错误。已提交的问题保留在历史中；失败文本和不完整回答不会保存为助手消息，也不会增加有效聊天次数或亲密度。

### 流式对话

```http
POST /chat/stream
```

```json
{
  "message": "Hello",
  "session_id": 1,
  "use_rag": true
}
```

流式响应首先发送会话信息，随后发送内容块。只有不含 `error` 的 `done: true` 表示成功；流开始后的模型失败以终止事件返回，调用方应将此前内容视为未完成并允许用户重试：

```text
data: {"content":"","done":true,"session_id":1,"error":"provider_unavailable","message":"暂时无法生成回答，请稍后重试。"}
```

显式会话在流开始前已不可用时仍返回 HTTP `404`；检查之后或模型生成期间被删除的情况以 `error: "session_not_found"` 终止流。同步接口在保存回答时发现原会话已删除也返回 `404`。即使数据库复用了会话编号，原请求也不能把问题、回答或宠物统计写入新会话。

每个请求的模型历史只读取到本轮问题，后提交的问题不会替换当前请求要回答的内容。并发回答仍按完成顺序保存，不承诺将同时提交的多个请求排成串行对话。

智谱适配器依据[官方对话补全文档](https://docs.bigmodel.cn/api-reference/模型-api/对话补全)检查结束状态：流必须收到 `[DONE]`，明确的非 `stop` 结束原因（包括长度限制、推理失败及内容拦截）均按未完成处理；本项目没有模型工具执行链，`tool_calls` 也不作为完整文本回答。同步响应兼容未提供 `finish_reason`，但必须包含非空文本；明确的失败或截断原因仍返回错误。内部语音聊天遵循同样约定，空回答返回 `503`，不会用占位回复伪装成功，也不自动重试。

### 会话列表

```http
GET /chat/sessions
```

`include_messages` 默认为 `true`，保持返回完整历史。侧栏只需要标题和更新时间时可使用 `GET /chat/sessions?include_messages=false`：仅返回当前账号的会话元数据，按更新时间倒序排列，`messages` 为 `[]`，服务端不查询消息表。选中会话后通过下面的单会话接口读取完整消息。

### 单个会话

```http
GET /chat/sessions/{session_id}
```

### 删除会话

```http
DELETE /chat/sessions/{session_id}
```

## RTC 语音 Demo 接口

RTC 的 `expiresAt` 和现有账号 `created_at`、`last_login_at` 使用 UTC；兼容响应可能不带 `Z`。展示端须将无时区的这些时间戳按 UTC 解析后转为本地时间，显式时区则按原偏移解析。日历日期字段不适用此规则。RTC 令牌内部使用 UTC Unix 秒，不受服务主机时区影响。

### 创建语音会话

```http
POST /rtc/voice-demo/session
```

请求体可省略；桌面端会传当前桌宠类型，用于语音回复 persona。

```json
{
  "pet_type": "dog"
}
```

返回示例：

```json
{
  "sessionId": "vs_xxx",
  "petType": "dog",
  "appId": "rtc_app_id",
  "roomId": "voice_demo_room_xxx",
  "userId": "user_1_xxx",
  "aiUserId": "BOTUSERXXX",
  "token": "rtc_token",
  "sessionActive": false,
  "state": "creating",
  "expiresAt": "2026-06-04T12:00:00"
}
```

### 启动语音会话

```http
POST /rtc/voice-demo/session/{session_id}/start
```

### 查询语音会话

```http
GET /rtc/voice-demo/session/{session_id}
```

### 打断 AI 回复

```http
POST /rtc/voice-demo/session/{session_id}/interrupt
```

### 停止语音会话

```http
POST /rtc/voice-demo/session/{session_id}/stop
```

## 知识库接口

### 上传文档

```http
POST /rag/upload
Content-Type: multipart/form-data
```

支持：

- `.txt`
- `.md`
- `.pdf`

限制：

- 单文件最大 `10 MB`
- 每用户最多 `20` 个文档

### 文档列表

```http
GET /rag/documents
```

### 删除文档

```http
DELETE /rag/documents/{document_id}
```

### RAG 查询

```http
POST /rag/query
```

```json
{
  "question": "Explain the uploaded document",
  "top_k": 4
}
```

## 管理员接口

### 后台总览

```http
GET /admin/overview
```

### 用户列表

```http
GET /admin/users?page=1&page_size=20&search=demo&status=active
```

### 用户详情

```http
GET /admin/users/{user_id}
```

### 创建用户

```http
POST /admin/users
```

### 更新用户

```http
PUT /admin/users/{user_id}
```

### 启用/禁用用户

```http
PATCH /admin/users/{user_id}/status
```

### 删除用户

```http
DELETE /admin/users/{user_id}
```

## 提醒

以下接口需登录，只访问当前用户的提醒；其他用户的 ID 返回 404。

| 接口 | 用途 |
| --- | --- |
| `GET /reminders?pet_type=pig&status=pending&triggered=false` | 读取未触发事项，按 `remind_at`、`id` 升序。未传 `due_before` 时包含未来事项；返回中也可能含周期实例，桌面一次性列表另行筛选。 |
| `PATCH /reminders/{id}` + `{"remind_at":"2026-10-01T01:30:00Z"}` | 改期，保留未提供的标题等字段。真实改期清空待处理事项的触发标记，重置邮件投递。 |
| `PATCH /reminders/{id}` + `{"status":"canceled"}` | 取消提醒并停止尚未完成的邮件投递。 |
| `POST /reminders/{id}/trigger` | 原子标记已到期的 pending 提醒；未来或已取消等非 pending 提醒返回 409，同一个已到期提醒重复触发保持幂等。 |
| `POST /reminders/{id}/complete` | 用户显式完成，触发状态本身不代表完成。 |

桌面改期校验未来时间并提交带时区的 ISO 字符串。接口本身保留历史时间输入能力；不带时区的时间按 UTC 处理，PATCH 的 `null` 时间视作不修改。上述操作不承诺撤回已发出的系统通知或邮件。

## 公共接口

### Windows 安装包信息

```http
GET /public/version/win-x64
```

返回示例：

```json
{
  "platform": "win-x64",
  "version": "DetachymAgentPet1.0",
  "filename": "DetachymAgentPet1.0.exe",
  "download_url": "/download/DetachymAgentPet1.0.exe",
  "available": true
}
```

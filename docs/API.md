# Detachym API 说明

## 基本信息

- Base URL：`/api/v1`
- 认证方式：`Authorization: Bearer <token>`

## 认证接口

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
Content-Type: multipart/form-data
```

字段：

- `username`：用户名或邮箱
- `password`：密码

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
  "bubble_frequency": 3
}
```

## 对话接口

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

### 会话列表

```http
GET /chat/sessions
```

### 单个会话

```http
GET /chat/sessions/{session_id}
```

### 删除会话

```http
DELETE /chat/sessions/{session_id}
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

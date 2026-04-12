# Detachym 部署说明

## 目标架构

- `postgres`：业务数据库
- `backend`：FastAPI API 服务
- `nginx`：Web 门户静态资源、`/api/*` 反代、`/download/*` 下载入口

当前线上目标：

- 域名：`detachym.top`
- ECS 公网 IP：`47.118.23.188`
- 系统：`AlmaLinux 10.1`
- 规格：`2 vCPU / 2 GiB RAM`

## 服务器准备

至少确保这些端口已经放行：

- `22/tcp`
- `80/tcp`
- `443/tcp`

如果服务器内存紧张，建议启用 2G swap。

## 配置文件

项目根目录使用 `.env` 作为生产配置。

可先从模板复制：

```bash
cp .env.example .env
```

重点检查这些变量：

- `SECRET_KEY`
- `ZHIPU_API_KEY`
- `SMTP_USER`
- `SMTP_PASSWORD`
- `WEB_APP_URL`
- `VITE_API_BASE_URL`
- `INITIAL_ADMIN_USERNAME`
- `INITIAL_ADMIN_EMAIL`
- `INITIAL_ADMIN_PASSWORD`

当前推荐值：

- `WEB_APP_URL=http://detachym.top`
- `VITE_API_BASE_URL=http://detachym.top/api/v1`

## Docker 部署

在项目根目录执行：

```bash
docker compose up -d --build
```

查看状态：

```bash
docker compose ps
docker compose logs -f backend
docker compose logs -f nginx
```

## 功能验证

健康检查：

```bash
curl http://127.0.0.1/health
```

发布信息：

```bash
curl http://127.0.0.1/api/v1/public/version/win-x64
```

公网验证：

- `http://detachym.top`
- `http://detachym.top/health`
- `http://detachym.top/api/v1/public/version/win-x64`

## 安装包发布

把桌面安装包放到：

```bash
data/downloads/DetachymAgentPet1.0.exe
```

发布后下载地址是：

```text
http://detachym.top/download/DetachymAgentPet1.0.exe
```

## 上线后检查

- 注册、登录、找回密码可用
- `/admin` 仅管理员可访问
- 文件上传与检索正常
- 下载页可正常返回安装包
- 邮件验证码发送正常

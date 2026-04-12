# GitHub 协作部署手册

这份手册适用于：

- 代码先上传到 `GitHub`
- 云端服务器通过 `git clone` 或 `git pull` 拉取
- 再用 `docker compose` 完成部署

## 1. 服务器首次拉取

如果服务器上之前跑过旧版 Python 服务或宿主机 Nginx，先停掉，避免占用 `80` 端口：

```bash
systemctl stop agent.service || true
systemctl disable agent.service || true
systemctl stop nginx.service || true
systemctl disable nginx.service || true
```

如果 Docker 曾经配置过异常镜像代理，可先重置：

```bash
printf '{}\n' > /etc/docker/daemon.json
systemctl restart docker
```

2G 内存机器建议先加 swap：

```bash
fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
grep -q '^/swapfile ' /etc/fstab || echo '/swapfile swap swap defaults 0 0' >> /etc/fstab
```

然后再拉代码：

```bash
cd /root
mkdir -p PersonalSpace
cd PersonalSpace
git clone https://github.com/qsjkc/AgentProject.git
cd AgentProject
```

如果仓库是私有仓库，使用你自己的 GitHub 凭据或 SSH key 拉取。

## 2. 准备配置

```bash
cp .env.example .env
```

然后编辑 `.env`，至少填好：

- `SECRET_KEY`
- `ZHIPU_API_KEY`
- `SMTP_USER`
- `SMTP_PASSWORD`
- `INITIAL_ADMIN_USERNAME`
- `INITIAL_ADMIN_EMAIL`
- `INITIAL_ADMIN_PASSWORD`

并确认：

```env
WEB_APP_URL=http://detachym.top
VITE_API_BASE_URL=http://detachym.top/api/v1
```

## 3. 发布桌面安装包

在服务器项目根目录创建下载目录：

```bash
mkdir -p data/downloads
```

再把安装包上传到：

```text
data/downloads/DetachymAgentPet1.0.exe
```

## 4. 启动服务

```bash
docker compose up -d --build
```

当前仓库里的 Docker 基础镜像已经切到 `docker.m.daocloud.io` 前缀，适合大陆网络环境，不需要你再手动改 Dockerfile。

## 5. 查看状态

```bash
docker compose ps
docker compose logs -f backend
docker compose logs -f nginx
```

公网验证：

```bash
curl http://detachym.top/health
curl http://detachym.top/api/v1/public/version/win-x64
```

## 6. 后续更新

以后代码更新只需要：

```bash
cd /root/PersonalSpace/AgentProject
git pull
docker compose up -d --build
```

如果桌面安装包版本变了，同时更新：

- `.env` 里的 `DESKTOP_RELEASE_VERSION`
- `.env` 里的 `DESKTOP_RELEASE_FILE`
- `data/downloads/` 里的实际安装包文件

## 7. 建议

- GitHub 只放源码和模板，不要上传真实密钥
- 真实配置只保留在服务器 `.env`
- 如果要对外正式发布，再补 HTTPS 和证书

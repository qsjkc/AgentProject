#!/bin/bash

set -euo pipefail

PROJECT_DIR="/root/PersonalSpace/AgentProject"

echo "=========================================="
echo " AgentProject Docker Deployment"
echo "=========================================="

echo "[1/5] Installing Docker runtime..."
dnf install -y dnf-plugins-core
dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin git
systemctl enable docker
systemctl start docker

echo "[2/5] Preparing runtime directories..."
mkdir -p "$PROJECT_DIR/data/postgres"
mkdir -p "$PROJECT_DIR/data/uploads"
mkdir -p "$PROJECT_DIR/data/chroma"
mkdir -p "$PROJECT_DIR/data/downloads"
mkdir -p "$PROJECT_DIR/logs"

echo "[3/5] Checking environment file..."
if [ ! -f "$PROJECT_DIR/.env" ]; then
  cp "$PROJECT_DIR/.env.example" "$PROJECT_DIR/.env"
  echo "Created $PROJECT_DIR/.env from template. Update secrets before exposing the service publicly."
fi

echo "[4/5] Preparing agent-server runtime env..."
AGENT_API_KEY="$(grep '^VOLC_AGENT_API_KEY=' "$PROJECT_DIR/.env" | cut -d= -f2- || true)"
BACKEND_INTERNAL_API_KEY="$(grep '^BACKEND_INTERNAL_API_KEY=' "$PROJECT_DIR/.env" | cut -d= -f2- || true)"

if [ -z "$AGENT_API_KEY" ] || [ -z "$BACKEND_INTERNAL_API_KEY" ]; then
  echo "VOLC_AGENT_API_KEY or BACKEND_INTERNAL_API_KEY is missing in $PROJECT_DIR/.env" >&2
  exit 1
fi

cat > "$PROJECT_DIR/agent-server/.env" <<EOF
AGENT_API_KEY=$AGENT_API_KEY
AGENT_LOG_LEVEL=info
AGENT_FIRST_CHUNK_TIMEOUT_MS=8000
AGENT_TOTAL_TIMEOUT_MS=45000
AGENT_TOOL_TIMEOUT_MS=5000
BACKEND_BASE_URL=http://agentproject-backend:5000
BACKEND_INTERNAL_API_KEY=$BACKEND_INTERNAL_API_KEY
EOF

echo "[5/6] Building and starting main services..."
cd "$PROJECT_DIR"
docker compose up -d --build

echo "[6/6] Building and starting agent-server..."
cd "$PROJECT_DIR/agent-server"
docker compose up -d --build

echo "Deployment completed."
echo ""
echo "Useful commands:"
echo "  cd $PROJECT_DIR && docker compose ps"
echo "  cd $PROJECT_DIR && docker compose logs -f backend"
echo "  cd $PROJECT_DIR && docker compose logs -f nginx"
echo "  cd $PROJECT_DIR/agent-server && docker compose ps"
echo "  cd $PROJECT_DIR/agent-server && docker compose logs -f agent-server"
echo ""
echo "Runtime notes:"
echo "  - Put Windows installers into $PROJECT_DIR/data/downloads"
echo "  - Update DESKTOP_RELEASE_VERSION and DESKTOP_RELEASE_FILE in .env for download API metadata"
echo "  - /agent/* will be proxied by the main nginx container to agent-server"
echo "  - Configure a domain and TLS reverse proxy before public release"

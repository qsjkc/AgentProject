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

echo "[4/5] Building and starting services..."
cd "$PROJECT_DIR"
docker compose up -d --build

echo "[5/5] Deployment completed."
echo ""
echo "Useful commands:"
echo "  docker compose ps"
echo "  docker compose logs -f backend"
echo "  docker compose logs -f nginx"
echo ""
echo "Runtime notes:"
echo "  - Put Windows installers into $PROJECT_DIR/data/downloads"
echo "  - Update DESKTOP_RELEASE_VERSION and DESKTOP_RELEASE_FILE in .env for download API metadata"
echo "  - Configure a domain and TLS reverse proxy before public release"

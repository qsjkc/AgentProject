#!/usr/bin/env bash
# Build once on a CI runner. No production credentials or runtime data are used.
set -euo pipefail
SOURCE_SHA="${1:?Usage: build_server_images.sh SOURCE_SHA OUTPUT_DIRECTORY}"
OUTPUT_DIR="${2:?An output directory is required}"
[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]]
test "$(git rev-parse HEAD)" = "$SOURCE_SHA"
mkdir -p "$OUTPUT_DIR"

for service in backend agent-server; do
  docker build --platform linux/amd64 --provenance=false --sbom=false \
    --build-arg PYTHON_BASE_IMAGE=python:3.11.9-slim-bookworm \
    --build-arg APT_MIRROR= --build-arg PIP_INDEX_URL=https://pypi.org/simple \
    --label "org.opencontainers.image.revision=$SOURCE_SHA" \
    --tag "agentproject-$service:sha-$SOURCE_SHA" "$service"
done
docker build --platform linux/amd64 --provenance=false --sbom=false --file deploy/Dockerfile.nginx \
  --build-arg NODE_BASE_IMAGE=node:20.11-alpine --build-arg NGINX_BASE_IMAGE=nginx:1.26-alpine \
  --build-arg NPM_REGISTRY=https://registry.npmjs.org \
  --label "org.opencontainers.image.revision=$SOURCE_SHA" \
  --tag "agentproject-nginx:sha-$SOURCE_SHA" .
docker image save --platform linux/amd64 "agentproject-backend:sha-$SOURCE_SHA" \
  "agentproject-nginx:sha-$SOURCE_SHA" "agentproject-agent-server:sha-$SOURCE_SHA" \
  | gzip -1 > "$OUTPUT_DIR/server-images.tar.gz"
python3 deploy/server_images.py create --directory "$OUTPUT_DIR" --source-commit "$SOURCE_SHA"

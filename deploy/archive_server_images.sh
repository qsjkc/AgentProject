#!/usr/bin/env bash
# Create the same verified release from locally loaded CI or CD images.
set -euo pipefail
SOURCE_SHA="${1:?Usage: archive_server_images.sh SOURCE_SHA OUTPUT_DIRECTORY}"
OUTPUT_DIR="${2:?An output directory is required}"
[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]]
test "$(git rev-parse HEAD)" = "$SOURCE_SHA"
mkdir -p "$OUTPUT_DIR"

docker image save --platform linux/amd64 "agentproject-backend:sha-$SOURCE_SHA" \
  "agentproject-nginx:sha-$SOURCE_SHA" "agentproject-agent-server:sha-$SOURCE_SHA" \
  | gzip -1 > "$OUTPUT_DIR/server-images.tar.gz"
python3 deploy/server_images.py create --directory "$OUTPUT_DIR" --source-commit "$SOURCE_SHA"

#!/usr/bin/env bash
# Start only isolated disposable containers; no production env files or mounts.
set -euo pipefail
SOURCE_SHA="${1:?Usage: smoke_server_images.sh SOURCE_SHA}"
[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]]
RUN_NAME="image-smoke-${SOURCE_SHA:0:12}-$$"
SMOKE_DIR="$(mktemp -d)"
CONTAINERS=()
NETWORK_CREATED=false
cleanup() {
  result=$?
  trap - EXIT
  for id in "${CONTAINERS[@]}"; do
    if [[ "$result" -ne 0 ]]; then docker logs --tail 60 "$id" || true; fi
    docker rm -f -v "$id" >/dev/null || true
  done
  if [[ "$NETWORK_CREATED" == true ]]; then docker network rm "$RUN_NAME" >/dev/null || true; fi
  rm -f -- "$SMOKE_DIR/fullchain.pem" "$SMOKE_DIR/privkey.pem"
  rmdir -- "$SMOKE_DIR"
  exit "$result"
}
trap cleanup EXIT
docker network create "$RUN_NAME" >/dev/null
NETWORK_CREATED=true
POSTGRES_ID="$(docker run -d --network "$RUN_NAME" --network-alias postgres \
  --name "$RUN_NAME-postgres" -e POSTGRES_DB=agent_project \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=smoke-only-password postgres:14-alpine)"
CONTAINERS+=("$POSTGRES_ID")
for attempt in $(seq 1 30); do
  if docker exec "$POSTGRES_ID" pg_isready -h 127.0.0.1 -U postgres -d agent_project; then break; fi
  [[ "$attempt" -lt 30 ]]
  sleep 2
done
BACKEND_ID="$(docker run -d --network "$RUN_NAME" --network-alias backend \
  --name "$RUN_NAME-backend" \
  -e DATABASE_URL=postgresql+asyncpg://postgres:smoke-only-password@postgres:5432/agent_project \
  -e SECRET_KEY=isolated-image-smoke-only-key -e REMINDER_EMAIL_WORKER_ENABLED=false \
  -e REMINDER_RECURRENCE_WORKER_ENABLED=false -e BACKEND_INTERNAL_API_KEY=isolated-image-smoke \
  "agentproject-backend:sha-$SOURCE_SHA")"
CONTAINERS+=("$BACKEND_ID")
AGENT_ID="$(docker run -d --network "$RUN_NAME" --network-alias agentproject-agent-server \
  --name "$RUN_NAME-agent" -e AGENT_API_KEY=isolated-image-smoke \
  -e BACKEND_BASE_URL=http://backend:5000 -e BACKEND_INTERNAL_API_KEY=isolated-image-smoke \
  "agentproject-agent-server:sha-$SOURCE_SHA")"
CONTAINERS+=("$AGENT_ID")
for attempt in $(seq 1 45); do
  if docker exec "$BACKEND_ID" python -c "import json,urllib.request; assert json.load(urllib.request.urlopen('http://127.0.0.1:5000/health/ready', timeout=5))['status']=='ready'"; then break; fi
  [[ "$attempt" -lt 45 ]]
  sleep 2
done
docker exec "$AGENT_ID" python -c "import json,urllib.request; assert json.load(urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=5))['status']=='ok'"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=detachym.top' \
  -keyout "$SMOKE_DIR/privkey.pem" -out "$SMOKE_DIR/fullchain.pem" >/dev/null 2>&1
NGINX_ID="$(docker run -d --network "$RUN_NAME" --network-alias nginx \
  --name "$RUN_NAME-nginx" \
  --mount "type=bind,src=$SMOKE_DIR,dst=/etc/letsencrypt/live/detachym.top,readonly" \
  "agentproject-nginx:sha-$SOURCE_SHA")"
CONTAINERS+=("$NGINX_ID")
for attempt in $(seq 1 15); do
  if docker exec "$BACKEND_ID" python -c "import json,ssl,urllib.request; ctx=ssl._create_unverified_context(); assert json.load(urllib.request.urlopen('https://nginx/health/ready',context=ctx,timeout=5))['status']=='ready'; assert json.load(urllib.request.urlopen('https://nginx/agent/health',context=ctx,timeout=5))['status']=='ok'; assert b'<html' in urllib.request.urlopen('https://nginx/',context=ctx,timeout=5).read().lower()"; then break; fi
  [[ "$attempt" -lt 15 ]]
  sleep 2
done
docker exec "$NGINX_ID" nginx -t
printf 'Image smoke passed: PostgreSQL migration, backend readiness, Agent health, HTTPS homepage and proxy routes.\n'

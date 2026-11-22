#!/usr/bin/env bash
set +x
set -euo pipefail

: "${GITHUB_ENV:?GITHUB_ENV is required}"
: "${SERVER_SSH_KEY:?SERVER_SSH_KEY is required}"

host_input="$(printf '%s' "${SERVER_HOST_RAW:-}" | tr -d '\r\n[:space:]')"
username="$(printf '%s' "${SERVER_USERNAME_RAW:-}" | tr -d '\r\n[:space:]')"
app_dir="$(printf '%s' "${SERVER_APP_DIR_RAW:-}" | tr -d '\r')"
app_dir="${app_dir:-/root/PersonalSpace/AgentProject}"
port="$(printf '%s' "${SERVER_PORT_RAW:-22}" | tr -d '\r\n[:space:]')"
port="${port#:}"
port="${port:-22}"

host_input="${host_input#ssh://}"
host_input="${host_input#http://}"
host_input="${host_input#https://}"
host_input="${host_input%%/*}"
host_input="${host_input##*@}"

if [[ "$host_input" =~ ^\[(.+)\]:(.+)$ ]] || [[ "$host_input" =~ ^([^:]+):([0-9]+)$ ]]; then
  host="${BASH_REMATCH[1]}"
  if [[ -z "${SERVER_PORT_RAW:-}" ]]; then
    port="${BASH_REMATCH[2]}"
  fi
elif [[ "$host_input" =~ ^\[(.+)\]$ ]]; then
  host="${BASH_REMATCH[1]}"
else
  host="$host_input"
fi

if [[ ! "$host" =~ ^[A-Za-z0-9_.:%-]+$ ]]; then
  echo 'SERVER_HOST must identify a host address or DNS name' >&2
  exit 1
fi
if [[ -z "$username" || "$username" == *'"'* || "$username" == *"'"* || "$username" == *'\'* || "$username" == *'#'* ]]; then
  echo 'SERVER_USERNAME must identify a user in the SSH configuration' >&2
  exit 1
fi
if [[ ! "$port" =~ ^[0-9]+$ ]]; then
  echo 'SERVER_PORT must be numeric' >&2
  exit 1
fi
# CD passes this path in single-quoted remote commands and on one GITHUB_ENV line.
if [[ "$app_dir" == *$'\n'* || "$app_dir" == *"'"* ]]; then
  echo 'SERVER_APP_DIR must be a single line without apostrophes' >&2
  exit 1
fi

ssh_dir="$HOME/.ssh"
umask 077
install -m 700 -d "$ssh_dir"
printf '%s' "$SERVER_SSH_KEY" > "$ssh_dir/id_ed25519"
chmod 600 "$ssh_dir/id_ed25519"
ssh-keygen -lf "$ssh_dir/id_ed25519" > /dev/null
touch "$ssh_dir/known_hosts"
chmod 600 "$ssh_dir/known_hosts"

cat > "$ssh_dir/config" <<EOF
Host deploy-target
  HostName $host
  User $username
  Port $port
  IdentityFile ~/.ssh/id_ed25519
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new
  BatchMode yes
  ConnectTimeout 30
  ServerAliveInterval 60
  ServerAliveCountMax 10
EOF
chmod 600 "$ssh_dir/config"

{
  printf 'DEPLOY_HOST=%s\n' "$host"
  printf 'DEPLOY_USER=%s\n' "$username"
  printf 'DEPLOY_PORT=%s\n' "$port"
  printf 'DEPLOY_APP_DIR=%s\n' "$app_dir"
} >> "$GITHUB_ENV"

echo 'SSH target deploy-target configured'

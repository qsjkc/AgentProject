#!/usr/bin/env bash
# Copy only to the configured deployment target with a deadline before service switch.
set -euo pipefail

deadline="${1:?Usage: transfer_release_files.sh DEADLINE DEPLOY_TARGET SOURCE...}"
destination="${2:?Deployment staging destination is required}"
shift 2
if [[ "$destination" != deploy-target:* ]] || (( $# == 0 )); then
  echo 'A deploy-target staging destination and local files are required' >&2
  exit 1
fi

for artifact in "$@"; do
  if [[ ! -f "$artifact" || ! -s "$artifact" ]]; then
    echo 'A verified release file is missing or empty' >&2
    exit 1
  fi
  printf 'Staging %s (%s bytes) via SSH, limit %s\n' "${artifact##*/}" "$(stat -c %s -- "$artifact")" "$deadline"
done

if timeout --kill-after=15s "$deadline" scp -B -- "$@" "$destination"; then
  echo 'SSH transfer finished'
else
  status=$?
  if [[ "$status" == 124 || "$status" == 137 ]]; then
    printf 'SSH release transfer exceeded its %s limit. ' "$deadline" >&2
  else
    printf 'SSH release transfer failed (exit %s). ' "$status" >&2
  fi
  echo 'Service switch has not started. Rerun Deploy Server to transfer the same release files again.' >&2
  exit "$status"
fi

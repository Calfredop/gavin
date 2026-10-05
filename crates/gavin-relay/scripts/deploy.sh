#!/usr/bin/env bash
# Build and (optionally) run the Relay image.
#
#   crates/gavin-relay/scripts/deploy.sh build
#   crates/gavin-relay/scripts/deploy.sh run [--env-file PATH] [--name NAME]
#   crates/gavin-relay/scripts/deploy.sh token
#   crates/gavin-relay/scripts/deploy.sh print-unit
#
# Configuration: docs/relay.md. Build context is always the repository root.

set -euo pipefail

repo="$(cd "$(dirname "$0")/../../.." && pwd)"
image="${GAVIN_RELAY_IMAGE:-gavin-relay}"
dockerfile="$repo/crates/gavin-relay/Dockerfile"

usage() {
  cat <<EOF
Usage:
  $(basename "$0") build
  $(basename "$0") run [--env-file PATH] [--name NAME] [--publish HOST:CONTAINER]
  $(basename "$0") token
  $(basename "$0") print-unit

Environment:
  GAVIN_RELAY_IMAGE   image tag (default: gavin-relay)
EOF
  exit 2
}

cmd="${1:-}"
shift || true

case "$cmd" in
  build)
    docker build -f "$dockerfile" -t "$image" "$repo"
    printf 'built %s\n' "$image"
    ;;

  run)
    env_file=""
    name="gavin-relay"
    publish="8443:8443"
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --env-file) env_file="$2"; shift 2 ;;
        --name) name="$2"; shift 2 ;;
        --publish) publish="$2"; shift 2 ;;
        *) usage ;;
      esac
    done
    if [[ -z "$env_file" ]]; then
      echo "gavin-relay: pass --env-file with at least GAVIN_RELAY_TOKENS (or TOKENS_FILE) and TLS" >&2
      exit 1
    fi
    if [[ ! -f "$env_file" ]]; then
      echo "gavin-relay: env file not found: $env_file" >&2
      exit 1
    fi
    # shellcheck disable=SC2086
    docker run -d --name "$name" --restart unless-stopped \
      -p "$publish" \
      --env-file "$env_file" \
      "$image"
    printf 'running %s (image %s)\n' "$name" "$image"
    docker logs --tail 5 "$name"
    ;;

  token)
    # 32 bytes, base64url without padding — long enough to be a shared secret,
    # short enough to type into Settings once.
    if command -v openssl >/dev/null 2>&1; then
      openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n'
      printf '\n'
    else
      # /dev/urandom is fine when openssl is missing (containers, minimal hosts).
      head -c 32 /dev/urandom | basenc --base64url -w0 2>/dev/null \
        || head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n'
      printf '\n'
    fi
    ;;

  print-unit)
    cat <<'UNIT'
# /etc/systemd/system/gavin-relay.service
# Drop the binary at /usr/local/bin/gavin-relay, put secrets in
# /etc/gavin-relay/env (0600), certificates beside it, then:
#   systemctl daemon-reload && systemctl enable --now gavin-relay

[Unit]
Description=Gavin Relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=gavin-relay
Group=gavin-relay
EnvironmentFile=/etc/gavin-relay/env
ExecStart=/usr/local/bin/gavin-relay
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=
AmbientCapabilities=
CapabilityBoundingSet=

[Install]
WantedBy=multi-user.target
UNIT
    ;;

  *)
    usage
    ;;
esac

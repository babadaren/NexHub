#!/usr/bin/env bash
set -euo pipefail

require() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing required command: $1" >&2
    exit 1
  }
}

secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
    return
  fi
  tr -dc 'A-Za-z0-9' </dev/urandom | head -c 64
}

confirm_non_empty_dir() {
  if [ ! -f .env ] && [ ! -f docker-compose.yml ] && [ ! -d data ] && [ ! -d postgres_data ] && [ ! -d redis_data ]; then
    return
  fi
  if [ "${PCC_INSTALL_ASSUME_YES:-}" = "true" ]; then
    return
  fi
  printf "Existing deployment files were found in %s. Continue preparing deployment? Non-empty .env values are preserved; docker-compose.yml is backed up before installing the default local template. [y/N] " "$(pwd)"
  read -r answer
  case "$answer" in
    y|Y|yes|YES) ;;
    *) echo "aborted"; exit 1 ;;
  esac
}

install_compose_file() {
  compose_source="${PCC_INSTALL_COMPOSE_SOURCE:-docker-compose.local.yml}"
  if [ ! -f "$compose_source" ]; then
    echo "missing compose template: $compose_source" >&2
    exit 1
  fi
  if [ -f docker-compose.yml ]; then
    if [ "${PCC_INSTALL_KEEP_COMPOSE:-}" = "true" ]; then
      echo "Keeping existing docker-compose.yml because PCC_INSTALL_KEEP_COMPOSE=true"
      return
    fi
    if cmp -s "$compose_source" docker-compose.yml; then
      return
    fi
    backup="docker-compose.yml.bak.$(date +%Y%m%d%H%M%S).$$"
    cp docker-compose.yml "$backup"
    echo "Existing docker-compose.yml backed up to $backup"
  fi
  cp "$compose_source" docker-compose.yml
}

set_env_value() {
  key="$1"
  value="$2"
  file=".env"
  escaped="$(printf '%s' "$value" | sed 's/[\/&]/\\&/g')"
  if grep -q "^${key}=" "$file"; then
    current="$(grep "^${key}=" "$file" | tail -n 1 | cut -d= -f2-)"
    if [ -z "$current" ]; then
      sed -i "s/^${key}=.*/${key}=${escaped}/" "$file"
    fi
  else
    printf "\n%s=%s\n" "$key" "$value" >>"$file"
  fi
}

require docker

if ! docker compose version >/dev/null 2>&1; then
  echo "docker compose v2 is required" >&2
  exit 1
fi

confirm_non_empty_dir

mkdir -p data postgres_data redis_data

if [ ! -f .env ]; then
  cp .env.example .env
fi

set_env_value POSTGRES_PASSWORD "$(secret)"
set_env_value JWT_SECRET "$(secret)"
set_env_value CONFIG_ENCRYPTION_KEY "$(secret)"
chmod 600 .env 2>/dev/null || true

install_compose_file

cat <<EOF
Deployment directory is ready.

Next steps:
  1. Review .env, especially BIND_HOST, SERVER_PORT, PUBLIC_BASE_URL, LOCAL_TCP_PORT_RANGE, LOCAL_UDP_PORT_RANGE.
  2. Start services:
     docker compose up -d
  3. Check health:
     curl http://127.0.0.1:8080/health
     curl http://127.0.0.1:8080/ready
  4. If ADMIN_PASSWORD is empty, read the generated password once from logs:
     docker compose logs app | grep -i admin

Data directories:
  ./data
  ./postgres_data
  ./redis_data

Backup recommendation:
  Stop services with docker compose down, then archive this deployment directory.
EOF

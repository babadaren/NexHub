#!/usr/bin/env bash
set -euo pipefail

require() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing required command: $1" >&2
    exit 1
  }
}

secret() {
  openssl rand -hex 32
}

require docker
require openssl

if docker compose version >/dev/null 2>&1; then
  :
else
  echo "docker compose v2 is required" >&2
  exit 1
fi

mkdir -p data postgres_data redis_data

if [ ! -f .env ]; then
  cp .env.example .env
  sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(secret)/" .env
  sed -i "s/^JWT_SECRET=.*/JWT_SECRET=$(secret)/" .env
  sed -i "s/^CONFIG_ENCRYPTION_KEY=.*/CONFIG_ENCRYPTION_KEY=$(secret)/" .env
  chmod 600 .env
fi

if [ ! -f docker-compose.yml ]; then
  cp docker-compose.local.yml docker-compose.yml
fi

echo "Deployment directory is ready."
echo "Review .env, then run: docker compose up -d"
echo "If ADMIN_PASSWORD is empty, run: docker compose logs app"

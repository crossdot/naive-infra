#!/usr/bin/env sh
# Install as /etc/letsencrypt/renewal-hooks/deploy/reload-naive-caddy.sh
# Update PROJECT_DIR to the absolute path of this project.
set -eu
PROJECT_DIR=/opt/naive-infra
cd "$PROJECT_DIR"
docker compose exec -T caddy caddy reload \
  --config /etc/caddy/Caddyfile --adapter caddyfile

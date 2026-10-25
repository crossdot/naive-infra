#!/usr/bin/env sh
set -eu
docker compose config --quiet
docker compose build --pull
docker compose run --rm --no-deps caddy \
  validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker compose run --rm --no-deps caddy list-modules | grep -q '^http.handlers.forward_proxy$'
echo "Compose config, image build, Caddyfile, and forward_proxy module checks passed."

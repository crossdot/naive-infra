#!/usr/bin/env sh
set -eu
docker compose config --quiet
docker compose build
docker compose up -d
docker compose ps

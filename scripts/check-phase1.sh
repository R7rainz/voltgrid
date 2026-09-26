#!/usr/bin/env bash
set -euo pipefail

repository_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
database_port="${VOLTGRID_TEST_DB_PORT:-55432}"
compose_project="voltgrid_phase1_test"
database_url="postgresql://voltgrid_dev:voltgrid@127.0.0.1:${database_port}/voltgrid"

cleanup() {
    POSTGRES_PORT="${database_port}" docker compose \
        --project-name "${compose_project}" \
        --file "${repository_dir}/csms/compose.yml" \
        down --volumes
}

trap cleanup EXIT

POSTGRES_PORT="${database_port}" docker compose \
    --project-name "${compose_project}" \
    --file "${repository_dir}/csms/compose.yml" \
    up --detach --wait

(
    cd "${repository_dir}/csms"
    DATABASE_URL="${database_url}" bunx prisma db update \
        --no-interactive --confirm voltgrid
    bun test
    DATABASE_URL="${database_url}" bun run test:phase1
    bun run build
)

(
    cd "${repository_dir}/dashboard"
    bun run build
)

(
    cd "${repository_dir}/load-balancer"
    GOCACHE="${GOCACHE:-/tmp/voltgrid-go-build}" go test ./...
)

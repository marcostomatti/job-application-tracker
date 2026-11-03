#!/bin/sh
# A stand-in for `pg_dump` that runs the database container's own copy, for a machine whose
# `pg_dump` is older than the Postgres 16 in docker-compose.yaml. Use it as the binary:
#
#   PG_DUMP_BIN=scripts/pg_dump-docker.sh bun run backup
#
# The backup code gives its binary --file=<path> and the connection as PGUSER, PGPASSWORD and
# PGDATABASE. The container's pg_dump writes to its standard output, which goes to that path on
# this machine. The password is passed by name (-e NAME), so it is in no command line.
set -eu

out=""
for arg in "$@"; do
  case "$arg" in
    --file=*) out="${arg#--file=}" ;;
    *) set -- "$@" "$arg" ;;
  esac
  shift
done
[ -n "$out" ] || { echo "pg_dump-docker.sh: no --file= argument" >&2; exit 2; }

cd "$(dirname "$0")/.."
exec docker compose exec -T -e PGUSER -e PGPASSWORD -e PGDATABASE db pg_dump "$@" > "$out"

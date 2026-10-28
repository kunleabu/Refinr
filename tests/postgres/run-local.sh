#!/usr/bin/env bash
# LOCAL regression tests only. No Supabase CLI, linked project, or remote database.
set -euo pipefail
research_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
research_tmp="$(mktemp -d /tmp/refinr-research-tests.XXXXXX)"
research_container="refinr-research-tests-$(basename "$research_tmp" | tr '[:upper:]' '[:lower:]')"
research_image='postgres:16@sha256:65b16a8b326e0cfbdf33fa7e783f2a0cb352a61448616ccccfd616ef42aa0f65'
cleanup() {
  docker rm -f "$research_container" >/dev/null 2>&1 || true
  rm -rf -- "$research_tmp"
}
trap cleanup EXIT
command -v docker >/dev/null
command -v python3 >/dev/null
python3 -m venv "$research_tmp/venv"
"$research_tmp/venv/bin/python" -m pip install --disable-pip-version-check -r "$research_root/tests/postgres/requirements.txt"
"$research_tmp/venv/bin/python" "$research_root/tests/postgres/check_migration.py"
docker run --rm -d --name "$research_container" -p 127.0.0.1::5432 \
  -e POSTGRES_HOST_AUTH_METHOD=trust "$research_image" >/dev/null
research_ready=false
for research_attempt in {1..60}; do
  if docker exec "$research_container" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then
    research_ready=true; break
  fi
  sleep 1
done
if [[ "$research_ready" != true ]]; then
  docker logs "$research_container"
  exit 1
fi
docker exec -i "$research_container" psql -U postgres -v ON_ERROR_STOP=1 <<'LOCAL_ONLY_SQL'
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role BYPASSRLS;
CREATE DATABASE refinr_phase2a_review;
\connect refinr_phase2a_review
CREATE SCHEMA auth;
CREATE TABLE auth.users(id uuid PRIMARY KEY);
GRANT USAGE ON SCHEMA auth TO service_role;
LOCAL_ONLY_SQL
docker exec -i "$research_container" psql -U postgres -d refinr_phase2a_review -v ON_ERROR_STOP=1 \
  < "$research_root/supabase/migrations/20261007000100_research_sessions_phase2a.sql"
research_port="$(docker port "$research_container" 5432/tcp)"
[[ "$research_port" =~ ^127\.0\.0\.1:([0-9]+)$ ]]
research_port="${BASH_REMATCH[1]}"
# Explicitly override any inherited DSN; do not read SUPABASE_* or production variables.
RESEARCH_TEST_DSN="host=127.0.0.1 port=$research_port user=postgres dbname=refinr_phase2a_review" \
  "$research_tmp/venv/bin/python" "$research_root/tests/postgres/test_research_sessions.py"

#!/usr/bin/env bash
# Checks on a real Docker host that the runner takes over a project stack the way Coolify ran it,
# in place: same containers, same volume, data kept, shared network only under the full names; then
# that its API restarts and deletes the stack. Everything it creates has its own names and is
# removed at the end. Needs the runner image (apps/control-plane/Dockerfile, --target runner).
#
#   bash apps/control-plane/test/runner-takeover.sh [IMAGE]      (on the Docker host, as root)
set -euo pipefail
IMAGE="${1:-supa-runner:test}"
ID=takeovertest0000runner01          # 24 [a-z0-9], like a Coolify uuid
REF=takeovertestrefabcde             # 20 [a-z]
SHARED=takeover-test-shared
WORK=/tmp/supa-runner-takeover
TOKEN=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
PW=$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')
say() { printf '\n==> %s\n' "$*"; }
fail() { printf '\n!! FAILED: %s\n' "$*" >&2; exit 1; }
[ ${#ID} -eq 24 ] && [ ${#REF} -eq 20 ] || fail "test ids have the wrong length"

cleanup() {
  docker rm -f takeover-test-runner >/dev/null 2>&1 || true
  docker compose -p "$ID" -f "$WORK/coolify-like.yml" down --volumes >/dev/null 2>&1 || true
  for c in $(docker ps -aq --filter "label=com.docker.compose.project=$ID"); do docker rm -f "$c" >/dev/null; done
  docker volume rm "${ID}_supabase-db-data" "${ID}_supabase-db-config" >/dev/null 2>&1 || true
  docker network rm "$ID" "$SHARED" takeover-test-api >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT
cleanup
mkdir -p "$WORK"

env_lines() {
  printf 'PROJECT_DB_PASSWORD=%s\nPROJECT_JWT_SECRET=%s\nPROJECT_ANON_KEY=eyJ.anon.test\nPROJECT_SERVICE_KEY=eyJ.service.test\nS3_ACCESS_KEY=testkey\nS3_SECRET_KEY=testsecret\n' "$PW" "${PW}${PW}"
}
runner() {
  docker run --rm -i -v /var/run/docker.sock:/var/run/docker.sock -v "$WORK:$WORK" \
    -e RUNNER_STACKS_DIR="$WORK/stacks" -e RUNNER_SHARED_NETWORK="$SHARED" \
    -e PROJECT_DOMAIN_SUFFIX=example.invalid -e PROJECT_S3_ENDPOINT=http://minio.invalid:9000 \
    -e PROJECT_IMGPROXY_URL=http://imgproxy.invalid:8080 -e PROJECTS_HOST_DIR="$WORK/projects" \
    "$@"
}
psql_x() { docker exec -e PGPASSWORD="$PW" "supabase-db-$ID" psql -h 127.0.0.1 -U supabase_admin -d postgres -Atc "$1"; }

say "1. A stack as Coolify runs one: compose project $ID, its own network, shared network attached by hand"
docker network create "$SHARED" >/dev/null
docker network create "$ID" >/dev/null
env_lines > "$WORK/coolify.env"
cat > "$WORK/coolify-like.yml" <<EOF
services:
  supabase-db:
    image: supabase/postgres:15.8.1.085
    container_name: supabase-db-$ID
    restart: unless-stopped
    env_file: [coolify.env]
    environment:
      POSTGRES_PASSWORD: $PW
      POSTGRES_HOST: /var/run/postgresql
      PGPORT: "5432"
      POSTGRES_DB: postgres
    healthcheck: {test: "pg_isready -U postgres -h 127.0.0.1", interval: 5s, timeout: 5s, retries: 30}
    volumes: ["${ID}_supabase-db-data:/var/lib/postgresql/data", "${ID}_supabase-db-config:/etc/postgresql-custom"]
    networks: ["$ID"]
volumes:
  ${ID}_supabase-db-data: {name: ${ID}_supabase-db-data}
  ${ID}_supabase-db-config: {name: ${ID}_supabase-db-config}
networks:
  $ID: {name: $ID, external: true}
EOF
docker compose -p "$ID" -f "$WORK/coolify-like.yml" up -d --wait >/dev/null
docker network connect --alias "supabase-db-$ID" "$SHARED" "supabase-db-$ID"
psql_x "create table takeover_check(x int); insert into takeover_check values (42)" >/dev/null
before=$(docker inspect -f '{{.Id}}' "supabase-db-$ID")
echo "  db up, row written, container ${before:0:12}"

say "2. The runner takes it over (secrets on stdin)"
env_lines | runner "$IMAGE" adopt "$REF" "$ID"
after=$(docker inspect -f '{{.Id}}' "supabase-db-$ID")
[ "$after" != "$before" ] || fail "the db container was not recreated from the template"
[ "$(docker inspect -f '{{index .Config.Labels "supa.stack"}}' "supabase-db-$ID")" = "$ID" ] || fail "no supa.stack label"
for _ in $(seq 1 60); do [ "$(docker inspect -f '{{.State.Health.Status}}' "supabase-db-$ID")" = healthy ] && break; sleep 2; done
[ "$(psql_x 'select x from takeover_check')" = 42 ] || fail "the row is gone: not the same volume"
echo "  same name, new container ${after:0:12}, the row is still there"
n=$(docker volume ls -q --filter "name=${ID}_" | wc -l)
[ "$n" -eq 2 ] || fail "$n volumes for the stack, expected the 2 it had"
shared_aliases=$(docker inspect -f "{{json (index .NetworkSettings.Networks \"$SHARED\").Aliases}}" "supabase-db-$ID")
case "$shared_aliases" in *'"supabase-db"'*) fail "short name supabase-db on the shared network: $shared_aliases" ;; esac
echo "  shared network aliases: $shared_aliases"
for svc in supabase-rest supabase-auth supabase-storage; do
  docker inspect "$svc-$ID" >/dev/null 2>&1 || fail "$svc-$ID was not created"
done
echo "  rest, auth, storage created as $svc-$ID and so on"

say "3. The API: status, restart, delete"
docker network create takeover-test-api >/dev/null
runner -d --name takeover-test-runner --network takeover-test-api -e RUNNER_TOKEN="$TOKEN" "$IMAGE" >/dev/null
api() { docker run --rm --network takeover-test-api curlimages/curl:8.11.1 -s -o /dev/null -w '%{http_code}' -X "$1" -H "Authorization: Bearer $TOKEN" "http://takeover-test-runner:8080$2"; }
for _ in $(seq 1 30); do [ "$(api GET /health)" = 200 ] && break; sleep 1; done
[ "$(api GET "/stacks/$ID")" = 200 ] || fail "GET /stacks/$ID"
[ "$(api GET "/stacks?ref=$REF")" = 200 ] || fail "GET /stacks?ref"
started=$(psql_x 'select pg_postmaster_start_time()')
[ "$(api POST "/stacks/$ID/restart")" = 204 ] || fail "restart"
for _ in $(seq 1 60); do [ "$(docker inspect -f '{{.State.Health.Status}}' "supabase-db-$ID")" = healthy ] && break; sleep 2; done
[ "$(psql_x 'select pg_postmaster_start_time()')" != "$started" ] || fail "Postgres did not restart"
[ "$(psql_x 'select x from takeover_check')" = 42 ] || fail "the row is gone after the restart"
echo "  restarted, row kept"
[ "$(api DELETE "/stacks/$ID")" = 204 ] || fail "delete"
[ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$ID")" ] || fail "containers left after delete"
[ -z "$(docker volume ls -q --filter "name=${ID}_")" ] || fail "volumes left after delete"
echo "  deleted: no containers, no volumes"

say "Takeover check passed."

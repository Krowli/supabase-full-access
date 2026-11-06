#!/usr/bin/env bash
# Checks point-in-time recovery end to end on the live platform (SPEC §22), with a project of its
# own, never an existing one:
#   1. a new project, PITR on for it, its database restarted, its first base backup;
#   2. rows written, the moment noted, the rows deleted;
#   3. a restore at that moment into another new project: the rows are there;
#   4. archiving broken on purpose: /health of the backup service says so within ~12 minutes (and the
#      container turns unhealthy, so the Telegram alert fires once), then repaired: /health is fine.
# Both projects are deleted at the end; their backups go with the usual retention
# (deleted_project_retention_days). Needs BACKUP_CONFIG to name the project with `pitr: true`.
#
#   bash apps/control-plane/test/pitr-live.sh [NAME]       (on the platform's server, as root; ~25 min)
set -euo pipefail
NAME="${1:-pitr-check}"
BACKUP="${BACKUP_CONTAINER:-supa-platform-backup-1}"
say() { printf '\n==> %s\n' "$*"; }
fail() { printf '\n!! FAILED: %s\n' "$*" >&2; exit 1; }

# call <cp|backup|runner> <METHOD> <path> [json]: the platform's own APIs, with the tokens the backup
# container holds (nothing is printed but the answer).
call() {
  docker exec -e S="$1" -e M="$2" -e P="$3" -e B="${4:-}" "$BACKUP" node --input-type=module -e '
    const e = process.env
    const base = { cp: e.CONTROL_PLANE_URL, backup: `http://127.0.0.1:${e.PORT || 8080}`, runner: e.RUNNER_URL }[e.S]
    const token = { cp: e.CONTROL_PLANE_TOKEN, backup: e.CONTROL_PLANE_TOKEN, runner: e.RUNNER_TOKEN }[e.S]
    const r = await fetch(base + e.P, { method: e.M, body: e.B || undefined,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } })
    const t = await r.text()
    if (!r.ok) { console.error(`${e.M} ${e.P} -> ${r.status} ${t.slice(0, 300)}`); process.exit(1) }
    process.stdout.write(t)'
}
# json <expression on `j`>: reads JSON on stdin.
json() { docker exec -i -e X="$1" "$BACKUP" node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s||"null");const v=eval(process.env.X);process.stdout.write(v===undefined||v===null?"":String(v))})'; }
sql() { docker exec "supabase-db-$1" psql -h 127.0.0.1 -U supabase_admin -d postgres -At -c "$2"; }
until_true() { # until_true <seconds> <what> <command...>
  local limit=$1 what=$2; shift 2
  for _ in $(seq $((limit / 10))); do "$@" && return 0; sleep 10; done
  fail "$what (waited ${limit}s)"
}

REF=""; NEW=""
cleanup() {
  for r in "$NEW" "$REF"; do [ -n "$r" ] && call cp DELETE "/projects/$r" >/dev/null 2>&1 || true; done
}
trap cleanup EXIT

say "leftovers of an earlier run (projects named $NAME or $NAME-restored only)"
for r in $(call cp GET /projects | json "(j.projects ?? j).filter((p) => p.name === '$NAME' || p.name === '$NAME-restored').map((p) => p.ref).join(' ')"); do
  call cp DELETE "/projects/$r" >/dev/null && echo "deleted $r"
done

say "a new project: $NAME"
REF=$(call cp POST /projects "{\"name\":\"$NAME\"}" | json j.ref)
active() { [ "$(call cp GET "/projects/$1" | json j.status)" = ACTIVE_HEALTHY ]; }
until_true 900 "project $REF did not start" active "$REF"
ID=$(call cp GET "/projects/$REF" | json j.coolify_service_uuid)
echo "ref $REF, stack $ID"

say "PITR settings written by the backup service (within ~6 minutes)"
pitr() { call backup GET "/projects/$REF" | json "$1"; }
configured() { docker exec "supabase-db-$ID" sh -c 'test -s /etc/postgresql-custom/wal-g.json && grep -q wal-push /etc/postgresql-custom/wal-g.conf'; }
until_true 420 "the backup service did not take up the project (is it in BACKUP_CONFIG with pitr: true?)" configured
[ "$(docker exec "supabase-db-$ID" stat -c %a /etc/postgresql-custom/wal-g.json)" = 600 ] || fail "wal-g.json is not mode 600"

say "restart of its database; archiving turns on, the first base backup follows"
call runner POST "/stacks/$ID/restart" >/dev/null
archiving() { [ "$(sql "$ID" 'show archive_mode' 2>/dev/null)" = on ]; }
until_true 300 "database did not come back with archiving on" archiving
has_backup() { [ "$(pitr 'j.pitr.backups.length')" -ge 1 ] 2>/dev/null; }
until_true 900 "no base backup" has_backup
pitr 'JSON.stringify(j.pitr)'; echo

say "rows, the moment, then the rows deleted"
sql "$ID" "create table public.pitr_check (id int primary key, note text); insert into public.pitr_check select g, 'row ' || g from generate_series(1, 25) g;" >/dev/null
sleep 3
AT=$(sql "$ID" "select to_char(now() at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')")
sleep 3
sql "$ID" "delete from public.pitr_check; insert into public.pitr_check values (999, 'after the moment');" >/dev/null
echo "moment $AT"

say "restore at $AT into a new project"
RUN=$(call backup POST "/projects/$REF/restore" "{\"target_time\":\"$AT\",\"name\":\"$NAME-restored\"}" | json j.id)
run_done() { s=$(call backup GET "/projects/$REF" | json "j.runs.find(r=>r.id==$RUN).status"); [ "$s" = succeeded ] || { [ "$s" = failed ] && fail "restore: $(call backup GET "/projects/$REF" | json "j.runs.find(r=>r.id==$RUN).error")"; false; }; }
until_true 1800 "restore did not finish" run_done
NEW=$(call backup GET "/projects/$REF" | json "j.runs.find(r=>r.id==$RUN).target_ref")
NEW_ID=$(call cp GET "/projects/$NEW" | json j.coolify_service_uuid)
call backup GET "/projects/$REF" | json "j.runs.find(r=>r.id==$RUN).warnings"; echo
GOT=$(sql "$NEW_ID" "select count(*) || ' ' || coalesce(max(id), 0) from public.pitr_check")
[ "$GOT" = "25 25" ] || fail "the restored project has '$GOT' (count, max id), not '25 25'"
echo "restored project $NEW has the 25 rows of $AT, not the row written after"
[ -z "$(docker ps -aq --filter "name=^pitr-$ID\$")" ] || fail "the copy pitr-$ID is still there"

say "archiving broken on purpose: /health must say so (the backup container turns unhealthy once)"
docker exec -u postgres "supabase-db-$ID" sh -c 'cp /etc/postgresql-custom/wal-g.json /tmp/wal-g.good && sed -i "s/\"AWS_SECRET_ACCESS_KEY\": \"/&broken/" /etc/postgresql-custom/wal-g.json'
sql "$ID" "insert into public.pitr_check values (1000, 'x'); select pg_switch_wal();" >/dev/null
health() { docker exec "$BACKUP" node -e 'fetch(`http://127.0.0.1:${process.env.PORT || 8080}/health`).then((r) => r.text()).then((t) => process.stdout.write(t))'; }
unhealthy() { health | grep -q "$NAME: WAL archiving fails"; }
until_true 1080 "/health did not report the broken archive" unhealthy
health; echo
docker exec -u postgres "supabase-db-$ID" sh -c 'mv /tmp/wal-g.good /etc/postgresql-custom/wal-g.json'
repaired() { ! health | grep -q "$NAME:"; }
until_true 600 "/health still reports $NAME after the repair" repaired

say "PASS"

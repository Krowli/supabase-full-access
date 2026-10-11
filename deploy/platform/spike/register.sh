#!/bin/sh
# Runs on server B. stdin: admin JWT secret, project postgres password, project JWT secret.
set -eu
read ADMIN; read PW; read PJWT
PL=$1; PR=$2; REF=proj1
jwt() { python3 - "$1" "$2" <<'PY'
import sys,json,hmac,hashlib,base64,time
sec,role=sys.argv[1],sys.argv[2]
b=lambda d: base64.urlsafe_b64encode(json.dumps(d,separators=(',',':')).encode()).rstrip(b'=')
h=b({'alg':'HS256','typ':'JWT'}); p=b({'role':role,'iss':'supabase','exp':int(time.time())+900})
s=base64.urlsafe_b64encode(hmac.new(sec.encode(),h+b'.'+p,hashlib.sha256).digest()).rstrip(b'=')
print((h+b'.'+p+b'.'+s).decode())
PY
}
AJ=$(jwt "$ADMIN" service_role); PJ=$(jwt "$PJWT" anon)
C="docker run --rm --network coolify curlimages/curl:8.10.1 -s"
echo "== Supavisor: register tenant"
$C -o /dev/null -w "PUT tenant -> %{http_code}\n" -X PUT "http://supavisor-$PL:4000/api/tenants/$REF" -H "Authorization: Bearer $AJ" -H "Content-Type: application/json" \
  -d "{\"tenant\":{\"db_host\":\"supabase-db-$PR\",\"db_port\":5432,\"db_database\":\"postgres\",\"ip_version\":\"auto\",\"require_user\":true,\"upstream_ssl\":false,\"enforce_ssl\":false,\"default_max_clients\":100,\"default_pool_size\":5,\"users\":[{\"db_user\":\"postgres\",\"db_password\":\"$PW\",\"pool_size\":5,\"mode_type\":\"transaction\",\"is_manager\":true}]}}"
echo "== Supavisor: connect through the pooler as postgres.$REF"
docker run --rm --network coolify -e PGPASSWORD="$PW" postgres:16-alpine psql -h supavisor-$PL -p 6543 -U postgres.$REF -d postgres -tAc "select 'pooled query ok on '||current_database()||', server '||inet_server_addr()" 2>&1 | tail -1
echo "== Realtime: register tenant"
$C -o /dev/null -w "POST tenant -> %{http_code}\n" -X POST "http://realtime-$PL:4000/api/tenants" -H "Authorization: Bearer $AJ" -H "Content-Type: application/json" \
  -d "{\"tenant\":{\"name\":\"$REF\",\"external_id\":\"$REF\",\"jwt_secret\":\"$PJWT\",\"extensions\":[{\"type\":\"postgres_cdc_rls\",\"settings\":{\"db_name\":\"postgres\",\"db_host\":\"supabase-db-$PR\",\"db_user\":\"supabase_admin\",\"db_password\":\"$PW\",\"db_port\":\"5432\",\"region\":\"us-east-1\",\"poll_interval_ms\":100,\"poll_max_record_bytes\":1048576,\"ssl_enforced\":false}}]}}"
$C -w "  health -> %{http_code}\n" "http://realtime-$PL:4000/api/tenants/$REF/health" -H "Authorization: Bearer $AJ" | cut -c1-200
echo "== Realtime: websocket for $REF picked by Host header"
$C -o /dev/null -w "ws upgrade (Host $REF.x) -> %{http_code}\n" --max-time 4 -H "Host: $REF.realtime.local" -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: x3JJHMbDL1EzLkh9GBhXDw==" "http://realtime-$PL:4000/socket/websocket?apikey=$PJ&vsn=1.0.0" || true
$C -o /dev/null -w "ws upgrade (Host other.x)  -> %{http_code}\n" --max-time 4 -H "Host: other.realtime.local" -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: x3JJHMbDL1EzLkh9GBhXDw==" "http://realtime-$PL:4000/socket/websocket?apikey=$PJ&vsn=1.0.0" || true

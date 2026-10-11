#!/bin/sh
# Runs on server B. stdin: p1 db password, p1 jwt secret, p2 db password, p2 jwt secret.
set -eu
K=$1; P1=$2; P2=$3
read PW1; read J1; read PW2; read J2
jwt() { python3 - "$1" <<'PY'
import sys,json,hmac,hashlib,base64,time
b=lambda d: base64.urlsafe_b64encode(json.dumps(d,separators=(',',':')).encode()).rstrip(b'=')
h=b({'alg':'HS256','typ':'JWT'}); p=b({'role':'anon','iss':'supabase','exp':int(time.time())+3600})
s=base64.urlsafe_b64encode(hmac.new(sys.argv[1].encode(),h+b'.'+p,hashlib.sha256).digest()).rstrip(b'=')
print((h+b'.'+p+b'.'+s).decode())
PY
}
A1=$(jwt "$J1"); A2=$(jwt "$J2")
setup() { # $1 uuid $2 password $3 name
  docker exec -i -e PGPASSWORD="$2" supabase-db-$1 psql -h localhost -U supabase_admin -d postgres -q -v ON_ERROR_STOP=1 >/dev/null <<SQL
alter role authenticator with password '$2';
create table if not exists public.whoami (project text);
truncate public.whoami; insert into public.whoami values ('$3');
grant select on public.whoami to anon;
SQL
  docker restart supabase-rest-$1 >/dev/null
}
setup $P1 "$PW1" project-one; setup $P2 "$PW2" project-two
F=/data/coolify/services/$K/kong.yml
write_conf() { # $1 = extra project count (0 or 1) to test reload with a config change
cat > $F <<YML
_format_version: '2.1'
consumers:
  - username: p1-anon
    keyauth_credentials: [{key: '$A1'}]
    acls: [{group: p1}]
  - username: p2-anon
    keyauth_credentials: [{key: '$A2'}]
    acls: [{group: p2}]
services:
  - name: p1-rest
    url: http://supabase-rest-$P1:3000/
    routes: [{name: p1-rest, hosts: [p1.supa.aioomi.com], paths: [/rest/v1/], strip_path: true}]
    plugins:
      - {name: key-auth, config: {hide_credentials: false}}
      - {name: acl, config: {allow: [p1], hide_groups_header: true}}
  - name: p2-rest
    url: http://supabase-rest-$P2:3000/
    routes: [{name: p2-rest, hosts: [p2.supa.aioomi.com], paths: [/rest/v1/], strip_path: true}]
    plugins:
      - {name: key-auth, config: {hide_credentials: false}}
      - {name: acl, config: {allow: [p2], hide_groups_header: true}}
YML
if [ "$1" = 1 ]; then cat >> $F <<YML
  - name: p3-rest
    url: http://supabase-rest-$P2:3000/
    routes: [{name: p3-rest, hosts: [p3.supa.aioomi.com], paths: [/rest/v1/], strip_path: true}]
YML
fi
}
reload() { docker exec kong-$K kong config parse /home/kong/kong.yml >/dev/null && docker exec kong-$K kong reload >/dev/null 2>&1; }
write_conf 0; reload; sleep 4
C="docker run --rm --network coolify curlimages/curl:8.10.1 -s"
req() { $C -w " -> %{http_code}" -H "Host: $1.supa.aioomi.com" -H "apikey: $2" -H "Authorization: Bearer $2" "http://kong-$K:8000/rest/v1/whoami?select=project"; echo; }
echo "p1 host + p1 key: $(req p1 $A1)"
echo "p2 host + p2 key: $(req p2 $A2)"
echo "p1 host + p2 key: $(req p1 $A2)"
echo "p2 host + p1 key: $(req p2 $A1)"
echo "p1 host, no key:  $($C -o /dev/null -w '%{http_code}' -H 'Host: p1.supa.aioomi.com' http://kong-$K:8000/rest/v1/whoami)"
echo "== reload under load: 300 requests while the config changes"
docker run --rm --network coolify --entrypoint sh curlimages/curl:8.10.1 -c "ok=0; bad=0; i=0; while [ \$i -lt 300 ]; do c=\$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: p1.supa.aioomi.com' -H 'apikey: $A1' -H 'Authorization: Bearer $A1' http://kong-$K:8000/rest/v1/whoami); [ \"\$c\" = 200 ] && ok=\$((ok+1)) || bad=\$((bad+1)); i=\$((i+1)); done; echo \"200: \$ok, other: \$bad\"" > /tmp/kong-load.txt &
LP=$!; sleep 1; write_conf 1; reload; sleep 1; write_conf 0; reload; wait $LP; cat /tmp/kong-load.txt; rm -f /tmp/kong-load.txt
echo "== a broken config is rejected before reload"
cp $F $F.bak; printf 'services: [ {name: broken\n' > $F; docker exec kong-$K kong config parse /home/kong/kong.yml >/dev/null 2>&1 && echo "parse accepted broken file (bad)" || echo "parse rejected broken file, reload skipped"; mv $F.bak $F
echo "after: $(req p1 $A1)"

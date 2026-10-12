#!/usr/bin/env python3
"""End-to-end check of the deployed platform stack (the M0 checks, automated). Run by hand:

    verify.py --app <platform Coolify application uuid>

The platform's secrets come from the application's Environment Variables in Coolify (the Coolify
API, token in ~/.coolify-token); nothing is written to disk.

Checks the dashboard (Studio at studio.<suffix>, basic auth). Creates one project through the
control-plane API, waits for ACTIVE_HEALTHY, checks REST, Auth,
Storage (+ MinIO and image transforms), the pooler and Realtime from the internet and from the
`coolify` network, that settings saved in Studio reach the project's GoTrue (live reload, email
template served over `coolify`) and storage-api (after a restart), restarts Kong to check the config comes back, measures RAM, then deletes the
project and checks every registration is gone. Secrets go to remote commands on stdin only and
are never printed. Needs SSH to server B through the jump host.
"""

import argparse
import base64
import hashlib
import hmac
import json
import secrets
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request
import zlib
from pathlib import Path

SSH = ['ssh', '-o', 'BatchMode=yes', '-J', 'root@203.0.113.10', 'root@10.10.0.1']
CURL = 'docker run --rm -i --network coolify curlimages/curl:8.10.1 -s -K -'
COOLIFY_API = 'https://coolify-admin.example.com/api/v1'
# The platform containers' aliases on the `coolify` network (platform-compose.yaml).
CP = 'http://supa-platform-control-plane:8080'
results: dict = {}
T0 = time.time()


def log(msg: str) -> None:
    print(f'[{time.time() - T0:6.1f}s] {msg}', flush=True)


def check(name: str, ok: bool, detail: str = '') -> None:
    results[name] = 'PASS' if ok else f'FAIL {detail}'
    log(f'{"PASS" if ok else "FAIL"} {name} {detail}')


def on_b(command: str, stdin: str = '') -> str:
    r = subprocess.run(SSH + [command], input=stdin, capture_output=True, text=True, timeout=300)
    if r.returncode != 0:
        raise RuntimeError(f'ssh failed ({r.returncode}): {r.stderr[:300]}')
    return r.stdout


def curl_cfg(**opts) -> str:
    """A curl config file (curl -K -): headers and data stay off every command line."""
    lines = []
    for k, v in opts.items():
        k = k.replace('_', '-')
        for item in v if isinstance(v, list) else [v]:
            lines.append(f'{k} = "{item}"' if item is not True else k)
    return '\n'.join(lines) + '\n'


def internal(method: str, url: str, headers: list[str] = [], data: str | None = None) -> tuple[int, str]:
    """curl from the `coolify` network on B; the config (with secrets) goes in on stdin."""
    cfg = curl_cfg(request=method, url=url, header=headers, write_out='\\n%{http_code}', max_time='120')
    if data is not None:
        cfg += f'data = {json.dumps(data)}\n'
    out = on_b(CURL, cfg)
    body, _, code = out.rpartition('\n')
    return int(code or 0), body


def public(method: str, url: str, headers: dict = {}, data: bytes | None = None) -> tuple[int, bytes]:
    req = urllib.request.Request(url, method=method, data=data, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return res.status, res.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def jwt(payload: dict, secret: str) -> str:
    b = lambda d: base64.urlsafe_b64encode(json.dumps(d, separators=(',', ':')).encode()).rstrip(b'=')
    head = b({'alg': 'HS256', 'typ': 'JWT'}) + b'.' + b(payload)
    sig = base64.urlsafe_b64encode(hmac.new(secret.encode(), head, hashlib.sha256).digest()).rstrip(b'=')
    return (head + b'.' + sig).decode()


def png() -> bytes:
    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d))
    raw = b''.join(b'\x00' + b'\xff\x00\x00' * 64 for _ in range(64))
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 64, 64, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))


def coolify(method: str, path: str):
    token = (Path.home() / '.coolify-token').read_text().strip()
    req = urllib.request.Request(COOLIFY_API + path, method=method, headers={'Authorization': f'Bearer {token}', 'Accept': 'application/json'})
    with urllib.request.urlopen(req, timeout=60) as res:
        text = res.read().decode()
        return json.loads(text) if text else None


def platform_env(app: str) -> dict:
    """The platform's generated secrets, under the names this script used to read from a file."""
    envs = {e['key']: e['value'] for e in coolify('GET', f'/applications/{app}/envs') if not e.get('is_preview')}
    names = {
        'CONTROL_PLANE_TOKEN': 'SERVICE_PASSWORD_CONTROLPLANE',
        'PLATFORM_ADMIN_JWT_SECRET': 'SERVICE_PASSWORD_64_ADMINJWT',
        'KONG_ADMIN_TOKEN': 'SERVICE_PASSWORD_KONGADMIN',
        'MINIO_ROOT_USER': 'SERVICE_USER_MINIO',
        'MINIO_ROOT_PASSWORD': 'SERVICE_PASSWORD_MINIO',
        'STUDIO_USER': 'SERVICE_USER_STUDIO',
        'STUDIO_PASSWORD': 'SERVICE_PASSWORD_STUDIO',
    }
    missing = [v for v in names.values() if not envs.get(v)]
    if missing:
        sys.exit(f'Coolify application {app} lacks {missing}')
    return {k: envs[v] for k, v in names.items()}


def container(app: str, service: str) -> str:
    """Coolify names application containers <service>-<uuid>-<timestamp>; find one by its labels."""
    name = on_b(f'docker ps --filter label=com.docker.compose.project={app} --filter label=com.docker.compose.service={service} --format "{{{{.Names}}}}"').strip()
    if not name or '\n' in name:
        raise RuntimeError(f'expected one running {service} container, got {name!r}')
    return name


def mem_mb(name_filter: str) -> dict:
    out = on_b(f"docker stats --no-stream --format '{{{{.Name}}}}\\t{{{{.MemUsage}}}}' $(docker ps -q --filter name={name_filter})")
    usage = {}
    for line in out.strip().splitlines():
        name, mem = line.split('\t')
        value = mem.split('/')[0].strip()
        n = float(value[:-3])
        usage[name] = round(n * {'KiB': 1 / 1024, 'MiB': 1, 'GiB': 1024}[value[-3:]], 1)
    return usage


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--app', required=True, help='platform Coolify application uuid')
    ap.add_argument('--suffix', default='supa.example.com')
    ap.add_argument('--projects-host-dir', default='/data/supa-platform/projects')
    args = ap.parse_args()
    env = platform_env(args.app)
    U = args.app
    cp = CP
    auth = [f'Authorization: Bearer {env["CONTROL_PLANE_TOKEN"]}', 'Content-Type: application/json']
    admin_jwt = lambda: jwt({'role': 'service_role', 'iat': int(time.time()), 'exp': int(time.time()) + 300}, env['PLATFORM_ADMIN_JWT_SECRET'])

    log(f'free memory on B: {on_b("free -m | awk \'/Mem/ {print $7}\'").strip()} MB available')

    studio = f'https://studio.{args.suffix}'
    code, _ = public('GET', f'{studio}/api/platform/profile')
    check('dashboard without credentials -> 401', code == 401, str(code))
    basic = base64.b64encode(f'{env["STUDIO_USER"]}:{env["STUDIO_PASSWORD"]}'.encode()).decode()
    code, _ = public('GET', f'{studio}/api/platform/profile', {'Authorization': f'Basic {basic}'})
    check('dashboard with credentials -> 200 (Studio answers)', code == 200, str(code))
    code, body = internal('GET', f'{cp}/hosts')
    check('/hosts lists the dashboard host', f'studio.{args.suffix}' in body.split())

    code, body = internal('POST', f'{cp}/projects', auth, json.dumps({'name': 'm5-verify'}))
    check('create -> 201', code == 201, str(code))
    ref = json.loads(body)['ref']
    log(f'project {ref}')

    t = time.time()
    last = None
    while time.time() - t < 600:
        code, body = internal('GET', f'{cp}/projects/{ref}', auth)
        p = json.loads(body)
        state = (p['status'], p.get('step'))
        if state != last:
            log(f'  {p["status"]} step={p.get("step")} ({time.time() - t:.0f}s)')
            last = state
        if p['status'] in ('ACTIVE_HEALTHY', 'FAILED'):
            break
        time.sleep(3)
    results['create_to_active_s'] = round(time.time() - t)
    check('ACTIVE_HEALTHY', p['status'] == 'ACTIVE_HEALTHY', str(p.get('last_error')))
    if p['status'] != 'ACTIVE_HEALTHY':
        sys.exit(1)
    uuid = p['coolify_service_uuid']
    _, body = internal('GET', f'{cp}/projects/{ref}/secrets', auth)
    s = json.loads(body)
    anon, service = s['anon_key'], s['service_key']
    base = f'https://{ref}.{args.suffix}'

    # The gateway host's timer requests the certificate within ~15 s plus the ACME round trip.
    t = time.time()
    while True:
        try:
            code, _ = public('GET', f'{base}/auth/v1/health', {'apikey': anon})
            break
        except (urllib.error.URLError, OSError) as e:
            if time.time() - t > 240:
                check('TLS certificate', False, str(e))
                sys.exit(1)
            time.sleep(5)
    results['certificate_s'] = round(time.time() - t)
    check('TLS certificate valid', True, f'after {results["certificate_s"]}s')

    h = lambda key: {'apikey': key, 'Authorization': f'Bearer {key}'}
    code, _ = public('GET', f'{base}/rest/v1/', h(anon))
    check('rest /rest/v1/ anon key -> 200', code == 200, str(code))
    foreign = jwt({'role': 'anon', 'iss': 'supabase', 'ref': 'otherprojectxxxxxxxx', 'exp': int(time.time()) + 600}, secrets.token_hex(24))
    code, _ = public('GET', f'{base}/rest/v1/', h(foreign))
    check('rest foreign key -> 401/403', code in (401, 403), str(code))
    code, _ = public('GET', f'{base}/rest/v1/')
    check('rest no key -> 401', code == 401, str(code))
    code, _ = public('GET', f'{base}/auth/v1/health', {'apikey': anon})
    check('auth /auth/v1/health -> 200', code == 200, str(code))

    sh = {**h(service), 'Content-Type': 'application/json'}
    code, body = public('POST', f'{base}/storage/v1/bucket', sh, json.dumps({'name': 'm5', 'public': False}).encode())
    check('storage create bucket -> 200', code == 200, f'{code} {body[:120]!r}')
    payload = f'hello from {ref} {secrets.token_hex(4)}'.encode()
    code, body = public('POST', f'{base}/storage/v1/object/m5/hello.txt', {**h(service), 'Content-Type': 'text/plain'}, payload)
    check('storage upload -> 200', code == 200, f'{code} {body[:120]!r}')
    code, body = public('GET', f'{base}/storage/v1/object/m5/hello.txt', h(service))
    check('storage download matches', code == 200 and body == payload, str(code))
    code, body = public('POST', f'{base}/storage/v1/object/m5/red.png', {**h(service), 'Content-Type': 'image/png'}, png())
    code, body = public('GET', f'{base}/storage/v1/render/image/authenticated/m5/red.png?width=16&height=16', h(service))
    check('storage image transform (imgproxy) -> 200 image', code == 200 and len(body) > 0, f'{code} {len(body)} bytes')

    # Settings Studio writes for this project (SPEC.md §16): the host dirs, the binds, a live GoTrue
    # reload, an email template fetched from Studio over `coolify`, and a storage limit after a restart.
    pdir = f'{args.projects_host_dir}/{ref}'
    owners = on_b(f'stat -c "%n %u:%g %a" {pdir} {pdir}/gotrue {pdir}/storage {pdir}/state').split('\n')
    check('settings dirs <ref>/{gotrue,storage,state} exist, owned 1000', len([o for o in owners if ' 1000:1000 ' in o]) == 4, ' | '.join(o.replace(pdir, '<dir>') for o in owners if o))
    mounts = on_b(f"docker inspect -f '{{{{range .Mounts}}}}{{{{.Source}}}}>{{{{.Destination}}}}:{{{{.RW}}}} {{{{end}}}}{{{{json .Config.Cmd}}}}' supabase-auth-{uuid} supabase-storage-{uuid}")
    check('GoTrue binds <ref>/gotrue read-only with --config-dir; storage binds <ref>/storage',
          f'{pdir}/gotrue>/etc/gotrue:false' in mounts and '--config-dir' in mounts and f'{pdir}/storage>/etc/studio-config:false' in mounts,
          mounts.replace(pdir, '<dir>').replace('\n', ' ')[:300])
    sb = {'Authorization': f'Basic {basic}', 'Content-Type': 'application/json'}
    code, _ = public('PATCH', f'{studio}/api/platform/auth/{ref}/config', sb, json.dumps({
        'EXTERNAL_ANONYMOUS_USERS_ENABLED': True,
        'MAILER_TEMPLATES_CONFIRMATION_CONTENT': '<p>m8-verify {{ .ConfirmationURL }}</p>',
    }).encode())
    check('Studio saves the project auth config -> 200', code == 200, str(code))
    t, anonymous = time.time(), None
    while time.time() - t < 60:
        code, body = public('GET', f'{base}/auth/v1/settings', {'apikey': anon})
        anonymous = json.loads(body).get('external', {}).get('anonymous_users') if code == 200 else None
        if anonymous is True:
            break
        time.sleep(2)
    results['auth_reload_s'] = round(time.time() - t)
    check('GoTrue applied the save without a restart (/auth/v1/settings external.anonymous_users)', anonymous is True, f'{results["auth_reload_s"]}s')
    reloaded = on_b(f'docker logs supabase-auth-{uuid} 2>&1 | grep -c "reloading api with new configuration" || true').strip()
    check('GoTrue logged "reloading api with new configuration"', reloaded != '0', reloaded)
    tmpl = on_b(f"docker exec supabase-auth-{uuid} sh -c '. /etc/gotrue/99_studio.env; wget -qO- \"$GOTRUE_MAILER_TEMPLATES_CONFIRMATION\"'")
    check('GoTrue fetches the saved email template from Studio over coolify', 'm8-verify' in tmpl, tmpl[:80])
    code, _ = public('PATCH', f'{studio}/api/platform/projects/{ref}/config/storage', sb, json.dumps({'fileSizeLimit': 1000}).encode())
    check('Studio saves the project storage config -> 200', code == 200, str(code))
    written = on_b(f'docker exec supabase-storage-{uuid} cat /etc/studio-config/storage.env')
    check('storage.env reaches the storage container', 'UPLOAD_FILE_SIZE_LIMIT="1000"' in written and 'ENABLE_IMAGE_TRANSFORMATION="true"' in written, written.replace('\n', ' ')[:200])
    on_b(f'docker restart supabase-storage-{uuid} >/dev/null')
    for _ in range(60):
        if on_b(f"docker inspect -f '{{{{.State.Health.Status}}}}' supabase-storage-{uuid}").strip() == 'healthy':
            break
        time.sleep(2)
    code_big, _ = public('POST', f'{base}/storage/v1/object/m5/big.bin', {**h(service), 'Content-Type': 'application/octet-stream'}, b'x' * 2000)
    code_small, _ = public('POST', f'{base}/storage/v1/object/m5/small.bin', {**h(service), 'Content-Type': 'application/octet-stream'}, b'x' * 500)
    check('after a storage restart the saved limit applies (2000 B refused, 500 B stored)', code_big in (400, 413) and code_small == 200, f'{code_big} / {code_small}')
    code, body = public('GET', f'{base}/storage/v1/render/image/authenticated/m5/red.png?width=16&height=16', h(service))
    check('image transforms still on after the save (mirrored stack setting)', code == 200 and len(body) > 0, str(code))

    minio = f'docker exec -i {container(U, "minio")} sh -c \'read U; read P; export MC_HOST_l="http://$U:$P@127.0.0.1:9000"; {{}}\''
    listing = on_b(minio.format(f'mc ls --recursive l/{ref}'), f'{env["MINIO_ROOT_USER"]}\n{env["MINIO_ROOT_PASSWORD"]}\n')
    check('object landed in MinIO bucket <ref>', 'hello.txt' in listing, listing.strip()[:200])
    # The project's own key reaches its bucket and nothing else.
    on_b(minio.format('mc mb --ignore-existing l/m5-isolation-probe >/dev/null'), f'{env["MINIO_ROOT_USER"]}\n{env["MINIO_ROOT_PASSWORD"]}\n')
    own = on_b(minio.format(f'mc ls l/{ref} >/dev/null 2>&1 && echo own-ok; mc ls l/m5-isolation-probe >/dev/null 2>&1 && echo other-ok || echo other-denied'), f'{s["s3_access_key"]}\n{s["s3_secret_key"]}\n')
    check('project S3 key: own bucket yes, other bucket no', 'own-ok' in own and 'other-denied' in own, own.strip().replace('\n', ' '))
    on_b(minio.format('mc rb --force l/m5-isolation-probe >/dev/null'), f'{env["MINIO_ROOT_USER"]}\n{env["MINIO_ROOT_PASSWORD"]}\n')

    psql = on_b(
        f"docker run --rm -i --network coolify postgres:17-alpine sh -c 'read PGPASSWORD; export PGPASSWORD; "
        f"psql -h supa-platform-supavisor -p 6543 -U postgres.{ref} -d postgres -tAc \"select \\$\\$project-db roles:\\$\\$||count(*) from pg_roles where rolname in (\\$\\$authenticator\\$\\$, \\$\\$supabase_admin\\$\\$)\"' 2>&1",
        f'{s["db_password"]}\n',
    )
    check('pooler psql as postgres.<ref> through Supavisor reaches the project db', 'project-db roles:2' in psql, psql.strip()[:120])

    ws = subprocess.run(
        ['curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', '--http1.1', '--max-time', '5', '-K', '-'],
        input=curl_cfg(url=f'{base}/realtime/v1/websocket?apikey={anon}&vsn=1.0.0', header=['Connection: Upgrade', 'Upgrade: websocket', 'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: x3JJHMbDL1EzLkh9GBhXDw==']),
        capture_output=True, text=True,
    ).stdout
    check('realtime websocket upgrade -> 101', ws == '101', ws)
    ws_bad = subprocess.run(
        ['curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', '--http1.1', '--max-time', '5', '-K', '-'],
        input=curl_cfg(url=f'{base}/realtime/v1/websocket?apikey={foreign}&vsn=1.0.0', header=['Connection: Upgrade', 'Upgrade: websocket', 'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: x3JJHMbDL1EzLkh9GBhXDw==']),
        capture_output=True, text=True,
    ).stdout
    check('realtime websocket with a foreign key -> 401/403', ws_bad in ('401', '403'), ws_bad)

    # A plain `docker restart` keeps Kong's config (DB-less Kong keeps it in LMDB inside the
    # container). A Coolify restart recreates every container of the platform stack, Kong and the
    # control plane included: Kong starts empty and the control plane re-applies from the registry.
    coolify('POST', f'/applications/{U}/restart')
    t = time.time()
    code, seen_down = 0, False
    while time.time() - t < 300:
        try:
            code, _ = public('GET', f'{base}/rest/v1/', h(anon))
        except (urllib.error.URLError, OSError):
            code = 0
        seen_down = seen_down or code != 200
        if code == 200 and seen_down:
            break
        time.sleep(2)
    results['platform_restart_recovery_s'] = round(time.time() - t)
    check('routes back after a Coolify restart of the platform stack', code == 200 and seen_down, f'{results["platform_restart_recovery_s"]}s')
    drift = on_b(f'docker logs {container(U, "control-plane")} 2>&1 | grep -c kong.drift || true').strip()
    check('control plane re-applied the Kong config after the restart', drift != '0', f'kong.drift events: {drift}')
    for _ in range(60):
        try:
            if internal('GET', f'{cp}/health')[0] == 200:
                break
        except RuntimeError:
            pass
        time.sleep(2)

    # The restart replaced the containers, and with them their names.
    minio = f'docker exec -i {container(U, "minio")} sh -c \'read U; read P; export MC_HOST_l="http://$U:$P@127.0.0.1:9000"; {{}}\''
    results['ram_platform_mb'] = mem_mb(U)
    results['ram_project_mb'] = mem_mb(uuid)
    log(f'RAM platform total {sum(results["ram_platform_mb"].values()):.0f} MB, project total {sum(results["ram_project_mb"].values()):.0f} MB')

    code, _ = internal('DELETE', f'{cp}/projects/{ref}', auth)
    check('delete -> 200', code == 200, str(code))
    code, _ = internal('GET', f'{cp}/projects/{ref}', auth)
    check('registry: project gone', code == 404, str(code))
    adm = [f'Authorization: Bearer {admin_jwt()}']
    code, _ = internal('GET', f'http://supa-platform-supavisor:4000/api/tenants/{ref}', adm)
    check('Supavisor tenant gone', code == 404, str(code))
    code, _ = internal('GET', f'http://supa-platform-realtime:4000/api/tenants/{ref}', adm)
    check('Realtime tenant gone', code == 404, str(code))
    code, body = internal('GET', f'http://supa-platform-kong:8001/services?size=1000', [f'x-admin-token: {env["KONG_ADMIN_TOKEN"]}'])
    check('Kong: no services or routes for the ref', code == 200 and ref not in body, f'{code} services={len(json.loads(body)["data"])}')
    code, body = internal('GET', f'{cp}/hosts')
    check('/hosts no longer lists the host', ref not in body)
    code, _ = public('GET', f'{base}/rest/v1/', h(anon))
    check('public REST for the deleted ref -> 404', code == 404, str(code))
    buckets = on_b(minio.format(f'mc ls l/; mc admin user svcacct info l {s["s3_access_key"]} >/dev/null 2>&1 && echo key-still-there || echo key-gone'), f'{env["MINIO_ROOT_USER"]}\n{env["MINIO_ROOT_PASSWORD"]}\n')
    check('MinIO bucket and scoped key gone', ref not in buckets and 'key-gone' in buckets, buckets.strip().replace('\n', ' ')[:200])
    gone = False
    for _ in range(30):
        if not on_b(f'docker ps -aq --filter name={uuid}').strip():
            gone = True
            break
        time.sleep(3)
    check('Coolify service containers gone', gone)
    for _ in range(30):
        leftovers = on_b(f'docker volume ls -q | grep -c {uuid} || true; docker network ls -q --filter name={uuid} | wc -l; ls -d /data/coolify/services/{uuid} 2>/dev/null | wc -l').split()
        if leftovers == ['0', '0', '0']:
            break
        time.sleep(3)
    check('no volumes, networks or service dir left', leftovers == ['0', '0', '0'], ' '.join(leftovers))
    check('settings dir <ref>/ removed', on_b(f'ls -d {pdir} 2>/dev/null | wc -l').strip() == '0')
    log(f'free memory on B: {on_b("free -m | awk \'/Mem/ {print $7}\'").strip()} MB available')
    print(json.dumps(results, indent=2))
    sys.exit(0 if all(v == 'PASS' for k, v in results.items() if isinstance(v, str)) else 1)


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Deploys the shared platform stack (platform-compose.yaml) as one Coolify service.

    deploy.py secrets FILE
        Creates FILE (mode 600) with every generated secret the stack needs; existing keys are
        kept, so running it again never rotates anything. Values are never printed.

    deploy.py deploy FILE --project UUID --environment NAME --server UUID --tag TAG
              --studio-image IMAGE@sha256:DIGEST [--service UUID] [--projects-environment NAME] [--domain-suffix SUFFIX]
        Renders the compose with the control-plane image tag and the Studio image, creates the Coolify service (or
        updates --service), turns on connect_to_docker_network, sets the env (secrets from FILE,
        the Coolify token from ~/.coolify-token) and (re)starts it. Prints the service uuid.

The Coolify API is https://coolify-admin.example.com/api/v1 unless COOLIFY_API is set.
"""

import argparse
import base64
import json
import os
import re
import secrets
import string
import sys
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
API = os.environ.get('COOLIFY_API', 'https://coolify-admin.example.com/api/v1')
ALNUM = string.ascii_letters + string.digits

# name -> length; all alphanumeric so they are safe in URLs, nginx strings and compose lines.
GENERATED = {
    'PLATFORM_DB_PASSWORD': 32,
    'PLATFORM_ADMIN_JWT_SECRET': 48,
    'SUPAVISOR_SECRET_KEY_BASE': 64,
    'SUPAVISOR_VAULT_ENC_KEY': 32,
    'REALTIME_SECRET_KEY_BASE': 64,
    'REALTIME_DB_ENC_KEY': 16,
    'PG_META_CRYPTO_KEY': 32,
    'MINIO_ROOT_USER': 16,
    'MINIO_ROOT_PASSWORD': 40,
    'KONG_ADMIN_TOKEN': 40,
    'CONTROL_PLANE_TOKEN': 40,
    'PLATFORM_SECRETS_KEY': 64,  # hex below: 32 bytes
    # Basic auth in front of Studio (Kong's dashboard route at studio.<suffix>).
    'DASHBOARD_USERNAME': 16,
    'DASHBOARD_PASSWORD': 32,
}


def gen(name: str, length: int) -> str:
    if name == 'PLATFORM_SECRETS_KEY':
        return secrets.token_hex(32)
    return ''.join(secrets.choice(ALNUM) for _ in range(length))


def read_env(path: Path) -> dict:
    out = {}
    for line in path.read_text().splitlines():
        if line and not line.startswith('#') and '=' in line:
            k, v = line.split('=', 1)
            out[k] = v
    return out


def cmd_secrets(path: Path) -> None:
    existing = read_env(path) if path.exists() else {}
    for name, length in GENERATED.items():
        existing.setdefault(name, gen(name, length))
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as f:
        f.write(''.join(f'{k}={v}\n' for k, v in existing.items()))
    os.chmod(path, 0o600)
    print(f'{path}: {len(existing)} keys (values not shown)')


def coolify(method: str, path: str, body=None):
    token = (Path.home() / '.coolify-token').read_text().strip()
    req = urllib.request.Request(
        API + path,
        method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={
            'Authorization': f'Bearer {token}',
            'Accept': 'application/json',
            'Content-Type': 'application/json',
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            text = res.read().decode()
            return json.loads(text) if text else None
    except urllib.error.HTTPError as e:
        # Env endpoints echo values back, so only the status and a short message are shown.
        detail = e.read().decode()[:300]
        sys.exit(f'Coolify {method} {path.split("?")[0]} -> {e.code}: {detail}')


def cmd_deploy(args) -> None:
    compose = (HERE / 'platform-compose.yaml').read_text()
    if not all(c in ALNUM + '.-_' for c in args.tag):
        sys.exit('bad tag')
    compose = compose.replace('{{CONTROL_PLANE_TAG}}', args.tag)
    if not re.fullmatch(r'[a-z0-9./_-]+(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}', args.studio_image):
        sys.exit('--studio-image must be pinned by digest: <image>[:tag]@sha256:<64 hex>')
    compose = compose.replace('{{STUDIO_IMAGE}}', args.studio_image)
    raw = base64.b64encode(compose.encode()).decode()

    uuid = args.service
    if uuid:
        coolify('PATCH', f'/services/{uuid}', {'docker_compose_raw': raw})
    else:
        uuid = coolify('POST', '/services', {
            'name': 'platform',
            'description': 'Shared Kong, Supavisor, Realtime, pg-meta, imgproxy, MinIO and the control plane',
            'project_uuid': args.project,
            'environment_name': args.environment,
            'server_uuid': args.server,
            'instant_deploy': False,
            'docker_compose_raw': raw,
        })['uuid']
    coolify('PATCH', f'/services/{uuid}', {'connect_to_docker_network': True})

    env = read_env(Path(args.file))
    missing = [k for k in GENERATED if k not in env]
    if missing:
        sys.exit(f'{args.file} lacks {missing}; run `deploy.py secrets {args.file}`')
    env.update({
        'CP_COOLIFY_URL': API,
        'CP_COOLIFY_TOKEN': (Path.home() / '.coolify-token').read_text().strip(),
        'CP_COOLIFY_PROJECT_UUID': args.project,
        'CP_COOLIFY_ENVIRONMENT': args.projects_environment,
        'CP_COOLIFY_SERVER_UUID': args.server,
        'PROJECT_DOMAIN_SUFFIX': args.domain_suffix,
        # The `coolify` network aliases of this stack's containers, as project stacks see them.
        'PROJECT_S3_ENDPOINT': f'http://minio-{uuid}:9000',
        'PROJECT_IMGPROXY_URL': f'http://imgproxy-{uuid}:8080',
        'STUDIO_INTERNAL_URL': f'http://studio-{uuid}:3000',
    })
    data = [{'key': k, 'value': v, 'is_literal': True} for k, v in env.items()]
    coolify('PATCH', f'/services/{uuid}/envs/bulk', {'data': data})

    status = (coolify('GET', f'/services/{uuid}') or {}).get('status', '')
    action = 'restart' if status.startswith(('running', 'starting', 'restarting')) else 'start'
    coolify('POST', f'/services/{uuid}/{action}')
    print(json.dumps({'service_uuid': uuid, 'action': action, 'env_keys': sorted(env)}))


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest='cmd', required=True)
    s = sub.add_parser('secrets')
    s.add_argument('file')
    d = sub.add_parser('deploy')
    d.add_argument('file')
    d.add_argument('--project', required=True)
    d.add_argument('--environment', required=True)
    d.add_argument('--server', required=True)
    d.add_argument('--tag', required=True)
    d.add_argument('--studio-image', required=True)
    d.add_argument('--service')
    d.add_argument('--projects-environment', default='projects')
    d.add_argument('--domain-suffix', default='supa.example.com')
    args = p.parse_args()
    if args.cmd == 'secrets':
        cmd_secrets(Path(args.file))
    else:
        cmd_deploy(args)


if __name__ == '__main__':
    main()

# Guardrails: what this fork must keep working

This fork runs production. Before you merge anything into `main` — an upstream
sync PR, a feature branch, a dependency bump — read this file and run the checks
at the end. If a change would break one of the items below, stop and ask the
owner; do not "fix" it by removing the fork's code.

Deeper detail lives in `FORK.md` (Studio pages, the upstream merge procedure) and
`deploy/platform/SPEC.md` (the platform and control plane). Operator facts
(servers, project names, buckets, secrets) are kept out of this public repo; if
you work on the owner's machine, `CLAUDE.local.md` points to them.

## 1. Branches, images, publishing

- Production builds from **`main`**. Never force-push `main`; merge, don't rebase.
- `upstream-master` is a mirror. `.github/workflows/upstream-sync.yml` refreshes
  it daily and opens a PR `upstream-master` → `main`. It never merges by itself.
  Merge it by the procedure in `FORK.md` ("Updating from upstream").
- Upstream's CI does **not** gate these PRs: its typecheck, Prettier and lint
  ratchet workflows only run on PRs into `master`, and the Studio unit tests on
  `master`/`studio`. Run the checks below yourself.
- Images:
  - `ghcr.io/krowli/supabase-full-access-studio`, built by
    `.github/workflows/studio-fork-publish.yml`. A push to `main` publishes
    `latest` and `YYYY.MM.DD-sha-<sha>` (pushes that touch only `deploy/**` or
    `apps/control-plane/**` are skipped). A manual run with `multi_project=true`
    publishes `platform` and `platform-<date>-sha-<sha>`.
  - Keep the pinned build args `STUDIO_FRAMEWORK=next` and
    `NEXT_PUBLIC_IS_MULTI_PROJECT`, and keep the `platform` tag's
    `enable=` condition as `inputs.multi_project == true` (a string compare
    breaks pushes, where the input is empty).
  - The control plane is built by Coolify from `apps/control-plane` on deploy;
    `control-plane-publish.yml` is manual and unused.
- Keep `'!apps/control-plane'` in `pnpm-workspace.yaml`: the control plane is
  not part of the pnpm workspace.

## 2. Studio: the self-hosted configuration pages

The fork makes Studio's settings pages work self-hosted. Upstream owns the files
with the fork's **gate edits**, so they are where merges conflict:

- Stage 1 (Authentication): the 4 edits in `FORK.md` "What this fork changes".
- Stage 2 (Realtime, Storage, S3, Data API, pooling): the 15 edits in its table.
- Explorer & Notebooks: the 3 edits in its section.

Each edit has a comment on the spot saying why. After a merge every one of them
must still be there.

Keep these exactly as named — renaming any of them silently drops saved
settings:

- Studio's state files in the `studio-auth-state` volume (`/var/lib/studio`):
  `auth-config.json`, `realtime-config.json`, `storage-config.json`.
- `99_studio.env`, rendered into GoTrue's config dir (`/etc/gotrue`), and
  `storage.env` in `STORAGE_CONFIG_DIR` (`/etc/studio-config`). Both are written
  atomically (temp file + rename).
- The keys in `MIRRORED_ENV_KEYS` (`apps/studio/lib/api/self-hosted/auth-config/index.ts`)
  and every variable `apps/studio/turbo.jsonc` names for the build.
- `AUTH_JWT_SECRET` must equal the stack's `JWT_SECRET`.
- Multi-project Studio reads projects from its fixed `projectsDir`
  (`/data/pieowl/projects` in `platform-compose.yaml`). Changing that path is a
  breaking change for running installs.
- `apps/studio/lib/api/self-hosted/project-env-guard.test.ts` must stay green: API
  code must not read a project's env vars around the resolver.
- Don't hand-merge `apps/studio/routeTree.gen.ts`; regenerate it.

## 3. The platform and its control plane

`apps/control-plane` and `deploy/platform/*` create and run projects
(`deploy/platform/SPEC.md` §5, §13–§20).

- The API (`apps/control-plane/src/server.ts`) is a contract other parts rely on:
  - `GET /health` and `GET /hosts` without a token (the gateway polls `/hosts`
    and its healthcheck depends on it);
  - `GET`/`POST /projects`, `GET`/`DELETE /projects/<ref>`,
    `GET /projects/<ref>/secrets`, `POST /projects/<ref>/stack`, with the bearer
    `CONTROL_PLANE_TOKEN`.
- The registry (schema `_platform` in `_supabase` on `platform-db`) holds every
  project; its secrets are encrypted with `PLATFORM_SECRETS_KEY`. Losing or
  rotating that key loses every project's secrets.
- `deploy/platform/project-compose.yaml` is the per-project template:
  `{{REF}}`, `{{PUBLIC_URL}}`, `{{PROJECTS_HOST_DIR}}` are filled by the control
  plane, `${PROJECT_*}`/`${S3_*}` come from Coolify. Images are pinned; bump them
  on purpose only. Existing projects pick up template changes only through
  `POST /projects/<ref>/stack`.
- `deploy/platform/platform-compose.yaml`:
  - fixed `supa-platform-*` aliases on the external `coolify` network (one
    platform per server);
  - Studio pinned by digest;
  - never rename Coolify's `SERVICE_*` magic variables: Coolify would generate
    new secrets and every project would lose its keys;
  - the gateway script stays in the compose `command`, not a `content:` file
    (Coolify keeps serving a stale copy of a `content:` file).

## 4. The single-stack Coolify compose

`deploy/coolify/docker-compose.yaml` differs from upstream's on purpose:

- `minio` and `minio-createbucket` use `ghcr.io/coollabsio/minio:<release>`:
  `quay.io/minio/mc` no longer allows anonymous pulls.
- `supabase-auth` runs with `--config-dir /etc/gotrue` and mounts
  `gotrue-config` read-only; Studio mounts `gotrue-config`, `studio-auth-state`
  and `./volumes/studio-config`.
- `supabase-storage`'s command is `set -a; . storage.env; exec node ...` —
  without `set -a` saved storage settings silently do nothing.
- Kong has `KONG_NGINX_HTTP_LARGE_CLIENT_HEADER_BUFFERS=4 32k` (fixes 414s on
  long `.in()` filters); `platform-compose.yaml` has the same.

## 5. Backups

`apps/control-plane/src/backup/`, SPEC §19.

- The `backup` service runs as `user: '0'`: Studio writes the settings files as
  root with mode 600.
- One restic repository per project, plus `_platform`. Each repository password
  is derived from `encryption_key` and the ref (`HMAC(encryption_key,
  "restic:<ref>")`). **Changing that derivation makes every existing backup
  unreadable.**
- A backup holds the roles, `pg_dump -Fc`, the pgsodium root key, the storage
  bucket and the project's settings dir. Don't drop any of them.
- Retention defaults: 7 daily, 4 weekly, 6 monthly; deleted projects kept
  `deleted_project_retention_days` (30).
- A run fails on purpose if the bucket has an expiration lifecycle rule.
- `/health` returns 503 when a backup failed or is overdue, so Coolify shows the
  platform unhealthy. Keep that.

## 6. Connections the apps depend on

- Supavisor: **transaction mode on 6543** (apps use it with `pgbouncer=true`) and
  **session mode on host port 6542** (mapped to container 5432; apps' direct
  URL). The user is `<role>.<ref>`; tenants use `require_user: false` and
  `auth_query` as `pgbouncer`. Changing the ports or the user format breaks every
  app's database connection.
- A project's `jwt_secret` and its anon/service keys (long-lived JWTs,
  `apps/control-plane/src/secrets.ts`) must never be regenerated by code: that
  logs every user out and breaks the apps' API keys.

## 7. Known traps

- storage-api can linger after SIGTERM; the reload loop in
  `project-compose.yaml` waits 5 s, then sends SIGKILL. Without it Kong answers
  502 for about a minute after a storage save (`test/storage-reload.test.ts`).
- A pooling save in Studio drops every pooled client session; that is expected,
  don't "fix" it by skipping the restart.

## Checks before merging into `main`

```bash
# Studio
npx -y pnpm@11.13.1 --filter studio typecheck
npx -y pnpm@11.13.1 --filter studio test
npx -y pnpm@11.13.1 test:prettier

# Control plane (not in the pnpm workspace)
cd apps/control-plane && npm test && npm run typecheck
```

Then, by reading the diff:

1. Every gate edit listed in `FORK.md` is still there, with its comment.
2. The three fork workflows (`upstream-sync.yml`, `studio-fork-publish.yml`,
   `control-plane-publish.yml`) and `pnpm-workspace.yaml` changed only on
   purpose.
3. `deploy/coolify/docker-compose.yaml` keeps everything in section 4.
4. Nothing renames the files, volumes, variables, ports or key derivations in
   sections 2–6.

After deploying the platform: `deploy/platform/verify.py --app <uuid>` passes,
and the platform shows healthy in Coolify (backups not overdue).

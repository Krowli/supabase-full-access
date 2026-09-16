# Supabase Full Access

A self-hosted build of Supabase Studio in which the pages the upstream image hides outside the
cloud work against your own containers: Authentication (Sign In / Providers, Emails and SMTP,
email templates, URL Configuration, Rate Limits, Sessions, Multi-Factor, Attack Protection, Auth
Hooks, Audit Logs, Performance, OAuth Server, OAuth Apps, Passkeys), Realtime settings, Storage
settings and S3 access keys, Data API settings, and Connection pooling. A save in the dashboard
lands in the configuration the running service actually reads — GoTrue's config directory,
Storage's env file, the Realtime and Supavisor admin APIs, or the `authenticator` role's PostgREST
settings — rather than in a hosted control plane. Not included: Authentication Overview,
Third-Party Auth, Backups and point-in-time recovery, Replication, Analytics and Vector buckets,
and Branching; those are cloud infrastructure rather than hidden pages, and nothing here adds
them. OAuth Server and OAuth Apps are un-hidden but speak to GoTrue's own admin API, and
[`FORK.md`](FORK.md) records them as unverified on a live stack.

## Install on Coolify

The fork is one image plus a set of compose edits. Everything else in the Coolify **Supabase**
service stays as the template created it. Take **path A** if you are creating the service now,
**path B** if a Supabase service is already running.

### A. A new Coolify service

1. In your Coolify project, choose **New resource → Supabase** and create the service.
2. Open the service, then **Configuration → General → Edit Compose File**.
3. Replace the entire contents with
   [`deploy/coolify/docker-compose.yaml`](deploy/coolify/docker-compose.yaml) from this repository.
   That file is the Coolify template with every fork change already applied.
4. Pin the Studio image. The file ships `:latest`, which works as is; for production change that
   one line to a dated tag from the
   [GHCR package page](https://github.com/Krowli/supabase-full-access/pkgs/container/supabase-full-access-studio):

   ```yaml
       image: 'ghcr.io/krowli/supabase-full-access-studio:YYYY.MM.DD-sha-XXXXXXX'
   ```

5. **Save**, then deploy the service.

**The variables Coolify generates are kept.** Coolify fills the `${SERVICE_*}` placeholders of a
service template with values it generates — the Postgres password, the JWT secret, the anon and
service keys, the dashboard login, the Kong URL. The file above names exactly the same fifteen, so
none of them has to be re-entered:

```
SERVICE_PASSWORD_ADMIN, SERVICE_PASSWORD_JWT, SERVICE_PASSWORD_LOGFLARE,
SERVICE_PASSWORD_LOGFLAREPRIVATE, SERVICE_PASSWORD_MINIO, SERVICE_PASSWORD_PGMETACRYPTO,
SERVICE_PASSWORD_POSTGRES, SERVICE_PASSWORD_SUPAVISORSECRET, SERVICE_PASSWORD_VAULTENC,
SERVICE_ROLE_KEY_ASYMMETRIC, SERVICE_SUPABASEANON_KEY, SERVICE_SUPABASESERVICE_KEY,
SERVICE_URL_SUPABASEKONG, SERVICE_USER_ADMIN, SERVICE_USER_MINIO
```

One variable name is new against the stock template, `POOLER_PROXY_PORT_TRANSACTION`, and it
carries its own default of `6543` in the file. Nothing has to be set by hand.

### B. An existing Coolify Supabase service

Open **Configuration → General → Edit Compose File** and make the edits below. They are the whole
difference between the stock template and this fork, in the order the services appear in the file.
Nothing else in the compose changes.

#### `supabase-studio` — the image

Replace the studio service's image line. **From** — your template's tag may be a different date:

```yaml
    image: 'supabase/studio:2026.09.07-sha-7996410'
```

**To**:

```yaml
    image: 'ghcr.io/krowli/supabase-full-access-studio:latest'
```

For production replace `latest` with a dated tag (`YYYY.MM.DD-sha-XXXXXXX`) from the
[GHCR package page](https://github.com/Krowli/supabase-full-access/pkgs/container/supabase-full-access-studio).

While you are in the file: if the `minio-createbucket` service still says `image: minio/mc`, change
it to `image: 'quay.io/minio/mc:RELEASE.2025-08-13T08-35-41Z'`. Docker Hub no longer serves the
MinIO images, and the deploy fails at pull with `pull access denied for minio/mc`.

#### `supabase-studio` — environment

Append to the service's existing `environment:` list:

```yaml
      - STUDIO_INTERNAL_URL=http://supabase-studio:3000
      - GOTRUE_CONFIG_DIR=/etc/gotrue
      - STUDIO_AUTH_STATE_DIR=/var/lib/studio
      - 'GOTRUE_SITE_URL=${GOTRUE_SITE_URL:-${SERVICE_URL_SUPABASEKONG}}'
      - 'GOTRUE_URI_ALLOW_LIST=${ADDITIONAL_REDIRECT_URLS}'
      - 'GOTRUE_DISABLE_SIGNUP=${DISABLE_SIGNUP:-false}'
      - 'GOTRUE_JWT_EXP=${JWT_EXPIRY:-3600}'
      - 'GOTRUE_EXTERNAL_EMAIL_ENABLED=${ENABLE_EMAIL_SIGNUP:-true}'
      - 'GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED=${ENABLE_ANONYMOUS_USERS:-false}'
      - 'GOTRUE_MAILER_AUTOCONFIRM=${ENABLE_EMAIL_AUTOCONFIRM:-false}'
      - 'GOTRUE_SMTP_ADMIN_EMAIL=${SMTP_ADMIN_EMAIL}'
      - 'GOTRUE_SMTP_HOST=${SMTP_HOST}'
      - 'GOTRUE_SMTP_PORT=${SMTP_PORT:-587}'
      - 'GOTRUE_SMTP_USER=${SMTP_USER}'
      - 'GOTRUE_SMTP_PASS=${SMTP_PASS}'
      - 'GOTRUE_SMTP_SENDER_NAME=${SMTP_SENDER_NAME}'
      - 'GOTRUE_EXTERNAL_PHONE_ENABLED=${ENABLE_PHONE_SIGNUP:-true}'
      - 'GOTRUE_SMS_AUTOCONFIRM=${ENABLE_PHONE_AUTOCONFIRM:-true}'
      - 'GOTRUE_MAILER_SUBJECTS_CONFIRMATION=${MAILER_SUBJECTS_CONFIRMATION}'
      - 'GOTRUE_MAILER_SUBJECTS_RECOVERY=${MAILER_SUBJECTS_RECOVERY}'
      - 'GOTRUE_MAILER_SUBJECTS_MAGIC_LINK=${MAILER_SUBJECTS_MAGIC_LINK}'
      - 'GOTRUE_MAILER_SUBJECTS_EMAIL_CHANGE=${MAILER_SUBJECTS_EMAIL_CHANGE}'
      - 'GOTRUE_MAILER_SUBJECTS_INVITE=${MAILER_SUBJECTS_INVITE}'
      - ENABLED_FEATURES_AUTHENTICATION_THIRD_PARTY_AUTH=false
      - STORAGE_CONFIG_DIR=/etc/studio-config
      - 'SUPAVISOR_URL=http://supabase-supavisor:4000'
      - 'POOLER_TENANT_ID=${POOLER_TENANT_ID:-dev_tenant}'
      - 'POOLER_PROXY_PORT_TRANSACTION=${POOLER_PROXY_PORT_TRANSACTION:-6543}'
      - 'REALTIME_URL=http://realtime-dev:4000'
      - REALTIME_TENANT_ID=realtime-dev
      - UPLOAD_FILE_SIZE_LIMIT=524288000
      - ENABLE_IMAGE_TRANSFORMATION=true
      - S3_PROTOCOL_ENABLED=true
```

#### `supabase-studio` — volumes

Append to the service's existing `volumes:` list:

```yaml
      - 'gotrue-config:/etc/gotrue'
      - 'studio-auth-state:/var/lib/studio'
      - './volumes/studio-config:/etc/studio-config'
```

#### `supabase-auth` — command and volumes

The stock auth service has neither. Add both directly under its `image:` line:

```yaml
    command:
      - auth
      - '--config-dir'
      - /etc/gotrue
    volumes:
      - 'gotrue-config:/etc/gotrue:ro'
```

`gotrue-config` is read-write on Studio and read-only here. Studio is the only writer.

#### `supabase-auth` — environment

Append to the service's existing `environment:` list:

```yaml
      - GOTRUE_MAILER_TEMPLATE_RELOADING_ENABLED=true
      - GOTRUE_MAILER_TEMPLATE_MAX_AGE=1m
```

Without those two, an edited email template keeps sending the old copy for up to ten minutes.

#### `supabase-storage` — command

The stock storage service has no `command:`. Add it directly under its `image:` line:

```yaml
    command:
      - sh
      - '-c'
      - 'set -a; [ -f /etc/studio-config/storage.env ] && . /etc/studio-config/storage.env; set +a; exec node dist/start/server.js'
```

`set -a` is not optional: without it the assignments stay shell-local, the storage server starts on
the compose values, and every Storage save is silently a no-op with nothing reporting it. The line
also assumes the image has no `ENTRYPOINT` and that its `CMD` is `node dist/start/server.js`, which
is what `supabase/storage-api` ships today. `docker inspect --format '{{json .Config}}'
supabase/storage-api:<tag>` says what your tag actually has.

#### `supabase-storage` — volumes

Append to the service's existing `volumes:` list:

```yaml
      - './volumes/studio-config:/etc/studio-config:ro'
```

#### Top level — `volumes:`

The Coolify template carries no top-level `volumes:` block at all, even though three named volumes
are already mounted in it. Add the block whole, at the end of the file and outside `services:`:

```yaml
volumes:
  supabase-db-data:
  supabase-db-config:
  deno-cache:
  gotrue-config:
  studio-auth-state:
```

#### Then restart

**Save**, then **Actions → Restart (pull latest)**. A plain **Restart** reuses the image already on
the host and never fetches the forked Studio.

One note on style: the blocks above are list-style (`- KEY=value`), which is the form the Coolify
Supabase template uses. If the compose you are editing writes `environment:` as a mapping, convert
them to `KEY: value` — YAML will not parse a block that is half list and half mapping, so never mix
the two under one service.

### Verify

**In the dashboard.** The Authentication menu now carries Sign In / Providers, Emails and SMTP, URL
Configuration, Rate Limits, Sessions, Multi-Factor, Attack Protection, Auth Hooks, Audit Logs and
Performance. Realtime → Settings, Storage → Files → Settings, Storage → S3, the connection pooling
card on Database → Settings, and the Data API page are all present.

**In the `supabase-auth` log.** At boot:

```
starting configuration reloader
```

Within about six seconds of a save in the dashboard:

```
reloading api with new configuration
```

A value GoTrue refuses leaves the running configuration alone and logs:

```
reloader: error loading config
```

**What Studio actually wrote:**

```bash
docker exec <auth-container> cat /etc/gotrue/99_studio.env
```

**Storage, where the restart is what applies a save.** Change the upload limit on
Storage → Files → Settings, then:

```bash
docker exec <storage-container> cat /etc/studio-config/storage.env
docker exec <storage-container> sh -c "tr '\0' '\n' < /proc/1/environ | grep UPLOAD_FILE_SIZE_LIMIT"
```

The second line reads PID 1's environment rather than running `env`, because `docker exec … env`
prints the compose environment and not the one the running server was started with. Before a
restart of `supabase-storage` the two disagree; after it they agree, and that is the pass.

[`FORK.md`](FORK.md) carries the fuller checks: the Data API max-rows `curl`, the deliberate
bad-value test that proves a rejected reload leaves GoTrue running, and the script that mints a
bearer token to read the Supavisor and Realtime tenants back.

### Update to a new version

- **Pinned to a dated tag**, which is the recommendation: change the tag on the studio `image:`
  line, **Save**, then **Actions → Restart (pull latest)**.
- **On `:latest`:** **Actions → Restart (pull latest)** on its own is the whole update.

New tags appear on the
[GHCR package page](https://github.com/Krowli/supabase-full-access/pkgs/container/supabase-full-access-studio)
on every push to `main` — see [Image](#image) below.

### One manual step afterwards

A Storage settings or S3 access key save writes the file but does not apply it — restart the
`supabase-storage` service to pick it up. Every other page applies its save on its own.

Everything deeper — the variables Studio reads and their defaults, how each config file is rendered
and applied, the known limitations of every page, and how to take changes from upstream — is in
[`FORK.md`](FORK.md).

## Install (plain docker compose)

Apply the same service changes to `docker/docker-compose.yml`: the two named volumes, the
`--config-dir` command on `supabase-auth`, the forked Studio image, and the environment added to
both services. The mapping, variable by variable, is in [`FORK.md`](FORK.md).

## Image

`ghcr.io/krowli/supabase-full-access-studio:<tag>`, built for `linux/amd64` by
[`.github/workflows/studio-fork-publish.yml`](.github/workflows/studio-fork-publish.yml) on every
push to `main`. Each run publishes `latest` and a dated `YYYY.MM.DD-sha-<sha>` tag; pin the dated
one.

## Updating from upstream

This repository is standalone, so upstream changes arrive by hand: `git merge upstream/master`
against `supabase/supabase`, with every conflict reviewed. The procedure, and the three places the
conflicts land, are in [`FORK.md`](FORK.md#updating-from-upstream).

## Documentation

- [`FORK.md`](FORK.md) — the operator guide: what the fork changes, the compose blocks to paste,
  how to verify a deployment, and the known limitations.
- [`deploy/coolify/docker-compose.yaml`](deploy/coolify/docker-compose.yaml) — the Coolify compose
  file with those changes already applied.

---

The upstream README follows.

<p align="center">
<img src="https://user-images.githubusercontent.com/8291514/213727234-cda046d6-28c6-491a-b284-b86c5cede25d.png#gh-light-mode-only">
<img src="https://user-images.githubusercontent.com/8291514/213727225-56186826-bee8-43b5-9b15-86e839d89393.png#gh-dark-mode-only">
</p>

# Supabase

[Supabase](https://supabase.com) is the Postgres development platform. We're building the features of Firebase using enterprise-grade open source tools.

- [x] Hosted Postgres Database. [Docs](https://supabase.com/docs/guides/database)
- [x] Authentication and Authorization. [Docs](https://supabase.com/docs/guides/auth)
- [x] Auto-generated APIs.
  - [x] REST. [Docs](https://supabase.com/docs/guides/api)
  - [x] GraphQL. [Docs](https://supabase.com/docs/guides/graphql)
  - [x] Realtime subscriptions. [Docs](https://supabase.com/docs/guides/realtime)
- [x] Functions.
  - [x] Database Functions. [Docs](https://supabase.com/docs/guides/database/functions)
  - [x] Edge Functions [Docs](https://supabase.com/docs/guides/functions)
- [x] File Storage. [Docs](https://supabase.com/docs/guides/storage)
- [x] AI + Vector/Embeddings Toolkit. [Docs](https://supabase.com/docs/guides/ai)
- [x] Dashboard

![Supabase Dashboard](https://raw.githubusercontent.com/supabase/supabase/master/apps/www/public/images/github/supabase-dashboard.png)

Watch "releases" of this repo to get notified of major updates.

<kbd><img src="https://raw.githubusercontent.com/supabase/supabase/d5f7f413ab356dc1a92075cb3cee4e40a957d5b1/web/static/watch-repo.gif" alt="Watch this repo"/></kbd>

## Documentation

For full documentation, visit [supabase.com/docs](https://supabase.com/docs)

To see how to Contribute, visit [Getting Started](./DEVELOPERS.md)

## Community & Support

- [Community Forum](https://github.com/supabase/supabase/discussions). Best for: help with building, discussion about database best practices.
- [GitHub Issues](https://github.com/supabase/supabase/issues). Best for: bugs and errors you encounter using Supabase.
- [Email Support](https://supabase.com/docs/support#business-support). Best for: problems with your database or infrastructure.
- [Discord](https://discord.supabase.com). Best for: sharing your applications and hanging out with the community.

## How it works

Supabase is a combination of open source tools. We’re building the features of Firebase using enterprise-grade, open source products. If the tools and communities exist, with an MIT, Apache 2, or equivalent open license, we will use and support that tool. If the tool doesn't exist, we build and open source it ourselves. Supabase is not a 1-to-1 mapping of Firebase. Our aim is to give developers a Firebase-like developer experience using open source tools.

**Architecture**

Supabase is a [hosted platform](https://supabase.com/dashboard). You can sign up and start using Supabase without installing anything.
You can also [self-host](https://supabase.com/docs/guides/hosting/overview) and [develop locally](https://supabase.com/docs/guides/local-development).

![Architecture](apps/docs/public/img/supabase-architecture.svg)

- [Postgres](https://www.postgresql.org/) is an object-relational database system with over 30 years of active development that has earned it a strong reputation for reliability, feature robustness, and performance.
- [Realtime](https://github.com/supabase/realtime) is an Elixir server that allows you to listen to PostgreSQL inserts, updates, and deletes using websockets. Realtime polls Postgres' built-in replication functionality for database changes, converts changes to JSON, then broadcasts the JSON over websockets to authorized clients.
- [PostgREST](http://postgrest.org/) is a web server that turns your PostgreSQL database directly into a RESTful API.
- [GoTrue](https://github.com/supabase/gotrue) is a JWT-based authentication API that simplifies user sign-ups, logins, and session management in your applications.
- [Storage](https://github.com/supabase/storage-api) a RESTful API for managing files in S3, with Postgres handling permissions.
- [pg_graphql](http://github.com/supabase/pg_graphql/) a PostgreSQL extension that exposes a GraphQL API.
- [postgres-meta](https://github.com/supabase/postgres-meta) is a RESTful API for managing your Postgres, allowing you to fetch tables, add roles, and run queries, etc.
- [Envoy](https://github.com/envoyproxy/envoy) is a cloud-native, high-performance edge and service proxy.

#### Client libraries

Our approach for client libraries is modular. Each sub-library is a standalone implementation for a single external system. This is one of the ways we support existing tools.

<table style="table-layout:fixed; white-space: nowrap;">
  <tr>
    <th>Language</th>
    <th>Client</th>
    <th colspan="5">Feature-Clients (bundled in Supabase client)</th>
  </tr>
  <!-- notranslate -->
  <tr>
    <th></th>
    <th>Supabase</th>
    <th><a href="https://github.com/postgrest/postgrest" target="_blank" rel="noopener noreferrer">PostgREST</a></th>
    <th><a href="https://github.com/supabase/gotrue" target="_blank" rel="noopener noreferrer">GoTrue</a></th>
    <th><a href="https://github.com/supabase/realtime" target="_blank" rel="noopener noreferrer">Realtime</a></th>
    <th><a href="https://github.com/supabase/storage-api" target="_blank" rel="noopener noreferrer">Storage</a></th>
    <th>Functions</th>
  </tr>
  <!-- TEMPLATE FOR NEW ROW -->
  <!-- START ROW
  <tr>
    <td>lang</td>
    <td><a href="https://github.com/supabase-community/supabase-lang" target="_blank" rel="noopener noreferrer">supabase-lang</a></td>
    <td><a href="https://github.com/supabase-community/postgrest-lang" target="_blank" rel="noopener noreferrer">postgrest-lang</a></td>
    <td><a href="https://github.com/supabase-community/gotrue-lang" target="_blank" rel="noopener noreferrer">gotrue-lang</a></td>
    <td><a href="https://github.com/supabase-community/realtime-lang" target="_blank" rel="noopener noreferrer">realtime-lang</a></td>
    <td><a href="https://github.com/supabase-community/storage-lang" target="_blank" rel="noopener noreferrer">storage-lang</a></td>
  </tr>
  END ROW -->
  <!-- /notranslate -->
  <th colspan="7">⚡️ Official ⚡️</th>
  <!-- notranslate -->
  <tr>
    <td>JavaScript (TypeScript)</td>
    <td><a href="https://github.com/supabase/supabase-js" target="_blank" rel="noopener noreferrer">supabase-js</a></td>
    <td><a href="https://github.com/supabase/supabase-js/tree/master/packages/core/postgrest-js" target="_blank" rel="noopener noreferrer">postgrest-js</a></td>
    <td><a href="https://github.com/supabase/supabase-js/tree/master/packages/core/auth-js" target="_blank" rel="noopener noreferrer">auth-js</a></td>
    <td><a href="https://github.com/supabase/supabase-js/tree/master/packages/core/realtime-js" target="_blank" rel="noopener noreferrer">realtime-js</a></td>
    <td><a href="https://github.com/supabase/supabase-js/tree/master/packages/core/storage-js" target="_blank" rel="noopener noreferrer">storage-js</a></td>
    <td><a href="https://github.com/supabase/supabase-js/tree/master/packages/core/functions-js" target="_blank" rel="noopener noreferrer">functions-js</a></td>
  </tr>
    <tr>
    <td>Flutter</td>
    <td><a href="https://github.com/supabase/supabase-flutter" target="_blank" rel="noopener noreferrer">supabase-flutter</a></td>
    <td><a href="https://github.com/supabase/supabase-flutter/tree/main/packages/postgrest" target="_blank" rel="noopener noreferrer">postgrest</a></td>
    <td><a href="https://github.com/supabase/supabase-flutter/tree/main/packages/supabase_auth" target="_blank" rel="noopener noreferrer">supabase_auth</a></td>
    <td><a href="https://github.com/supabase/supabase-flutter/tree/main/packages/supabase_realtime" target="_blank" rel="noopener noreferrer">supabase_realtime</a></td>
    <td><a href="https://github.com/supabase/supabase-flutter/tree/main/packages/supabase_storage" target="_blank" rel="noopener noreferrer">supabase_storage</a></td>
    <td><a href="https://github.com/supabase/supabase-flutter/tree/main/packages/supabase_functions" target="_blank" rel="noopener noreferrer">supabase_functions</a></td>
  </tr>
  <tr>
    <td>Swift</td>
    <td><a href="https://github.com/supabase/supabase-swift" target="_blank" rel="noopener noreferrer">supabase-swift</a></td>
    <td><a href="https://github.com/supabase/supabase-swift/tree/main/Sources/PostgREST" target="_blank" rel="noopener noreferrer">postgrest-swift</a></td>
    <td><a href="https://github.com/supabase/supabase-swift/tree/main/Sources/Auth" target="_blank" rel="noopener noreferrer">auth-swift</a></td>
    <td><a href="https://github.com/supabase/supabase-swift/tree/main/Sources/Realtime" target="_blank" rel="noopener noreferrer">realtime-swift</a></td>
    <td><a href="https://github.com/supabase/supabase-swift/tree/main/Sources/Storage" target="_blank" rel="noopener noreferrer">storage-swift</a></td>
    <td><a href="https://github.com/supabase/supabase-swift/tree/main/Sources/Functions" target="_blank" rel="noopener noreferrer">functions-swift</a></td>
  </tr>
  <tr>
    <td>Python</td>
    <td><a href="https://github.com/supabase/supabase-py" target="_blank" rel="noopener noreferrer">supabase-py</a></td>
    <td><a href="https://github.com/supabase/postgrest-py" target="_blank" rel="noopener noreferrer">postgrest-py</a></td>
    <td><a href="https://github.com/supabase/gotrue-py" target="_blank" rel="noopener noreferrer">gotrue-py</a></td>
    <td><a href="https://github.com/supabase/realtime-py" target="_blank" rel="noopener noreferrer">realtime-py</a></td>
    <td><a href="https://github.com/supabase/storage-py" target="_blank" rel="noopener noreferrer">storage-py</a></td>
    <td><a href="https://github.com/supabase/functions-py" target="_blank" rel="noopener noreferrer">functions-py</a></td>
  </tr>
  <!-- /notranslate -->
  <th colspan="7">💚 Community 💚</th>
  <!-- notranslate -->
  <tr>
    <td>C#</td>
    <td><a href="https://github.com/supabase-community/supabase-csharp" target="_blank" rel="noopener noreferrer">supabase-csharp</a></td>
    <td><a href="https://github.com/supabase-community/postgrest-csharp" target="_blank" rel="noopener noreferrer">postgrest-csharp</a></td>
    <td><a href="https://github.com/supabase-community/gotrue-csharp" target="_blank" rel="noopener noreferrer">gotrue-csharp</a></td>
    <td><a href="https://github.com/supabase-community/realtime-csharp" target="_blank" rel="noopener noreferrer">realtime-csharp</a></td>
    <td><a href="https://github.com/supabase-community/storage-csharp" target="_blank" rel="noopener noreferrer">storage-csharp</a></td>
    <td><a href="https://github.com/supabase-community/functions-csharp" target="_blank" rel="noopener noreferrer">functions-csharp</a></td>
  </tr>
  <tr>
    <td>Go</td>
    <td>-</td>
    <td><a href="https://github.com/supabase-community/postgrest-go" target="_blank" rel="noopener noreferrer">postgrest-go</a></td>
    <td><a href="https://github.com/supabase-community/gotrue-go" target="_blank" rel="noopener noreferrer">gotrue-go</a></td>
    <td>-</td>
    <td><a href="https://github.com/supabase-community/storage-go" target="_blank" rel="noopener noreferrer">storage-go</a></td>
    <td><a href="https://github.com/supabase-community/functions-go" target="_blank" rel="noopener noreferrer">functions-go</a></td>
  </tr>
  <tr>
    <td>Java</td>
    <td>-</td>
    <td>-</td>
    <td><a href="https://github.com/supabase-community/gotrue-java" target="_blank" rel="noopener noreferrer">gotrue-java</a></td>
    <td>-</td>
    <td><a href="https://github.com/supabase-community/storage-java" target="_blank" rel="noopener noreferrer">storage-java</a></td>
    <td>-</td>
  </tr>
  <tr>
    <td>Kotlin</td>
    <td><a href="https://github.com/supabase-community/supabase-kt" target="_blank" rel="noopener noreferrer">supabase-kt</a></td>
    <td><a href="https://github.com/supabase-community/supabase-kt/tree/master/Postgrest" target="_blank" rel="noopener noreferrer">postgrest-kt</a></td>
    <td><a href="https://github.com/supabase-community/supabase-kt/tree/master/Auth" target="_blank" rel="noopener noreferrer">auth-kt</a></td>
    <td><a href="https://github.com/supabase-community/supabase-kt/tree/master/Realtime" target="_blank" rel="noopener noreferrer">realtime-kt</a></td>
    <td><a href="https://github.com/supabase-community/supabase-kt/tree/master/Storage" target="_blank" rel="noopener noreferrer">storage-kt</a></td>
    <td><a href="https://github.com/supabase-community/supabase-kt/tree/master/Functions" target="_blank" rel="noopener noreferrer">functions-kt</a></td>
  </tr>
  <tr>
    <td>Ruby</td>
    <td><a href="https://github.com/supabase-community/supabase-rb" target="_blank" rel="noopener noreferrer">supabase-rb</a></td>
    <td><a href="https://github.com/supabase-community/postgrest-rb" target="_blank" rel="noopener noreferrer">postgrest-rb</a></td>
    <td>-</td>
    <td>-</td>
    <td>-</td>
    <td>-</td>
  </tr>
  <tr>
    <td>Rust</td>
    <td>-</td>
    <td><a href="https://github.com/supabase-community/postgrest-rs" target="_blank" rel="noopener noreferrer">postgrest-rs</a></td>
    <td>-</td>
    <td>-</td>
    <td>-</td>
    <td>-</td>
  </tr>
  <tr>
    <td>Godot Engine (GDScript)</td>
    <td><a href="https://github.com/supabase-community/godot-engine.supabase" target="_blank" rel="noopener noreferrer">supabase-gdscript</a></td>
    <td>-</td>
    <td>-</td>
    <td>-</td>
    <td>-</td>
    <td>-</td>
  </tr>
  <!-- /notranslate -->
</table>

<!--- Remove this list if you're translating to another language, it's hard to keep updated across multiple files-->
<!--- Keep only the link to the list of translation files-->

## Badges

![Made with Supabase](./apps/www/public/badge-made-with-supabase.svg)

```md
[![Made with Supabase](https://supabase.com/badge-made-with-supabase.svg)](https://supabase.com)
```

```html
<a href="https://supabase.com">
  <img
    width="168"
    height="30"
    src="https://supabase.com/badge-made-with-supabase.svg"
    alt="Made with Supabase"
  />
</a>
```

![Made with Supabase (dark)](./apps/www/public/badge-made-with-supabase-dark.svg)

```md
[![Made with Supabase](https://supabase.com/badge-made-with-supabase-dark.svg)](https://supabase.com)
```

```html
<a href="https://supabase.com">
  <img
    width="168"
    height="30"
    src="https://supabase.com/badge-made-with-supabase-dark.svg"
    alt="Made with Supabase"
  />
</a>
```

## Translations

- [Arabic | العربية](/i18n/README.ar.md)
- [Albanian / Shqip](/i18n/README.sq.md)
- [Bangla / বাংলা](/i18n/README.bn.md)
- [Bulgarian / Български](/i18n/README.bg.md)
- [Catalan / Català](/i18n/README.ca.md)
- [Croatian / Hrvatski](/i18n/README.hr.md)
- [Czech / čeština](/i18n/README.cs.md)
- [Danish / Dansk](/i18n/README.da.md)
- [Dutch / Nederlands](/i18n/README.nl.md)
- [English](https://github.com/supabase/supabase)
- [Estonian / eesti keel](/i18n/README.et.md)
- [Finnish / Suomalainen](/i18n/README.fi.md)
- [French / Français](/i18n/README.fr.md)
- [German / Deutsch](/i18n/README.de.md)
- [Greek / Ελληνικά](/i18n/README.el.md)
- [Gujarati / ગુજરાતી](/i18n/README.gu.md)
- [Hebrew / עברית](/i18n/README.he.md)
- [Hindi / हिंदी](/i18n/README.hi.md)
- [Hungarian / Magyar](/i18n/README.hu.md)
- [Nepali / नेपाली](/i18n/README.ne.md)
- [Indonesian / Bahasa Indonesia](/i18n/README.id.md)
- [Italiano / Italian](/i18n/README.it.md)
- [Japanese / 日本語](/i18n/README.jp.md)
- [Korean / 한국어](/i18n/README.ko.md)
- [Lithuanian / lietuvių](/i18n/README.lt.md)
- [Latvian / latviski](/i18n/README.lv.md)
- [Malay / Bahasa Malaysia](/i18n/README.ms.md)
- [Norwegian (Bokmål) / Norsk (Bokmål)](/i18n/README.nb.md)
- [Persian / فارسی](/i18n/README.fa.md)
- [Polish / Polski](/i18n/README.pl.md)
- [Portuguese / Português](/i18n/README.pt.md)
- [Portuguese (Brazilian) / Português Brasileiro](/i18n/README.pt-br.md)
- [Romanian / Română](/i18n/README.ro.md)
- [Russian / Pусский](/i18n/README.ru.md)
- [Serbian / Srpski](/i18n/README.sr.md)
- [Sinhala / සිංහල](/i18n/README.si.md)
- [Slovak / slovenský](/i18n/README.sk.md)
- [Slovenian / Slovenščina](/i18n/README.sl.md)
- [Spanish / Español](/i18n/README.es.md)
- [Simplified Chinese / 简体中文](/i18n/README.zh-cn.md)
- [Swedish / Svenska](/i18n/README.sv.md)
- [Thai / ไทย](/i18n/README.th.md)
- [Traditional Chinese / 繁體中文](/i18n/README.zh-tw.md)
- [Turkish / Türkçe](/i18n/README.tr.md)
- [Ukrainian / Українська](/i18n/README.uk.md)
- [Vietnamese / Tiếng Việt](/i18n/README.vi-vn.md)
- [List of translations](/i18n/languages.md) <!--- Keep only this -->

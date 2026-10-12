# Multi-project self-hosted Studio: design spec

Status: draft, 2026-10-12. Branch `platform/control-plane`. M0 done (§8); M1 code done (§9); M2 and the M3 Studio side code done, server checks pending (§11); M6 Studio side code done, server check pending (§12).

Goal: one Studio on the database server that lists many projects, switches between them, and has
a "New project" button. Each project gets its own Postgres, GoTrue, PostgREST and storage-api.
Kong, Logflare and vector, Realtime, Supavisor, postgres-meta, imgproxy and MinIO are shared.
Provisioning goes through the Coolify API. The daily upstream sync must keep merging cleanly.

Conventions:

- Every `path:line` is relative to the repo root and was read for this spec.
- **[assumption]** marks behaviour of a service or of Coolify that is not visible in this repo
  and must be checked before building on it.
- `studio/` is short for `apps/studio/`.

**Recommendation in one line.** Use option **B+**: keep `IS_PLATFORM=false`, make Studio's
existing self-hosted `/api/platform/*` routes resolve their backends per `ref`, and put the
registry and provisioner in a new `apps/control-plane` service. The full platform mode (option A)
turns off about 85 local routes, including every fork backend, and makes all of them a rewrite.
Estimates: about 6 days for switching between projects that are registered by hand, about 15 days
with the create button. A is 25-35 days.

---

## 1. How Studio picks platform or self-hosted

**The flag**

- `IS_PLATFORM = process.env.NEXT_PUBLIC_IS_PLATFORM === 'true'`
  (`studio/lib/constants/index.ts:5`). `packages/common/constants/environment.ts:1` defines it
  the same way.
- It is a `NEXT_PUBLIC_` variable, so Next inlines it at build time. Changing it means a
  different image. **[assumption]** The fork's publish workflow builds with the default `false`.

**The API base**

- `API_URL` is chosen at `studio/lib/constants/index.ts:35-46`.
  - Platform: `NEXT_PUBLIC_API_URL` (:38).
  - Self-hosted in the browser: `/api` (:40), which is Studio's own Next routes.
- The fetch client strips `/platform` from the base (`studio/data/fetchers.ts:33`), and every
  path already starts with `/platform/...`.
- `PG_META_URL` is `PLATFORM_PG_META_URL` on platform and `STUDIO_PG_META_URL` self-hosted
  (`studio/lib/constants/index.ts:48-50`).

**What changes when the flag is true**

- **Local API is switched off.** `studio/proxy.ts:13-19` answers 404 for every `/api/*` path
  except the allowlist in `studio/lib/hosted-api-allowlist.ts:5-32`, which covers AI and status
  routes only. All 112 files under `studio/pages/api` stop answering, including every fork route
  in FORK.md.
- **Self-hosted helpers refuse to run.** They call `assertSelfHosted()`
  (`studio/lib/api/self-hosted/util.ts:17-21`).
- **Login becomes real.**
  - `studio/lib/auth.tsx:37` passes `alwaysLoggedIn={!IS_PLATFORM}`. Self-hosted, a fake session
    with no access token is used (`packages/common/auth.tsx:19-40,114-119`).
  - On platform, `withAuth` enforces a GoTrue session, the AAL level and permissions
    (`studio/hooks/misc/withAuth.tsx:28-31` and on).
  - The fetch client then sends `Authorization: Bearer <GoTrue access token>`
    (`studio/data/fetchers.ts:52-64`), taken from the GoTrue at `NEXT_PUBLIC_GOTRUE_URL`
    (`packages/common/gotrue.ts:183-194`).
- **Database calls need a connection string.** `pgMetaGuard` throws before sending any pg-meta
  call that has no `x-connection-encrypted` header (`studio/data/fetchers.ts:45-50,95-112`).
  Project detail is re-polled every 5 s while the connection string is invalid
  (`studio/data/projects/project-detail-query.ts:108-116`).
- **Platform-only features switch on:**
  - feature flags (`studio/pages/_app.tsx:185`, `enabled={IS_PLATFORM}`);
  - permissions;
  - entitlements, where a missing entitlement means the feature is hidden;
  - the selected-org query (`studio/pages/_app.tsx:103`).

**What the switcher UI does with the flag**

- `LayoutHeader.tsx:144`: the org dropdown shows only when `IS_PLATFORM`.
- `LayoutHeader.tsx:163,178`: the divider and the branch dropdown show only when `IS_PLATFORM`.
  The file is at `studio/components/layouts/Navigation/LayoutHeader/`.
- `ProjectDropdown.tsx:182-190`: when `IS_PLATFORM`, the header uses
  `ProjectDropdownPlatformView`, a searchable project list with "New project" linking to
  `/new/<org slug>` (:40). Otherwise it shows the project name only. The file is at
  `studio/components/layouts/AppLayout/`.
- `studio/components/interfaces/App/CommandMenu/OrgProjectSwitcher.tsx:19,61,82,96`: the
  command-menu queries are enabled only when `IS_PLATFORM`.
- The project shell itself has no flag branch. `ProjectLayout`, `useSelectedProject` and
  `project-detail-query.ts:33` always call `GET /platform/projects/{ref}`. Most `?? 'default'`
  uses of a ref in components are fallbacks for when there is no ref in the URL.

**Where the `default` project is hard-coded (self-hosted)**

- `studio/lib/constants/api.ts:13-24`: `DEFAULT_PROJECT = { id: 1, ref: 'default', organization_id: 1, status: 'ACTIVE_HEALTHY', region: 'local', ... }`.
  Lines 1-11 derive `PROJECT_REST_URL` and the DB host from `SUPABASE_PUBLIC_URL`.
- `studio/pages/api/platform/projects/index.ts:20-23`: GET only, returns `[DEFAULT_PROJECT]`.
  There is no POST.
- `studio/pages/api/platform/projects/[ref]/index.ts:20-28`: ignores `ref` and returns
  `DEFAULT_PROJECT` with `connectionString: ''`.
- `studio/pages/api/platform/organizations/index.ts:21-36`: one org with slug
  `default-org-slug`.
- `studio/pages/api/platform/profile/index.ts:22-37`: a fake user whose one org embeds
  `DEFAULT_PROJECT`.
- Redirects to `/project/default`:
  - `studio/redirects.shared.ts:33-41` (`SELF_HOSTED_REDIRECTS`);
  - `studio/routes/index.tsx:28-42`;
  - `studio/pages/sign-in.tsx:45-50`;
  - `studio/components/interfaces/App/RouteValidationWrapper.tsx:28-32`;
  - `HomeIcon.tsx:29`.
- Fork code:
  - `studio/lib/api/self-hosted/settings.ts:41` has `ref: 'default'`.
  - `studio/lib/api/self-hosted/auth-config/index.ts:212` builds the GoTrue template URL
    `.../api/platform/auth/default/templates`.
- `studio/lib/api/apiWrapper.ts:42` checks auth only when `IS_PLATFORM && withAuth`, so the
  self-hosted routes are unauthenticated. Kong's basic auth in front of Studio is the only gate.

## 2. Endpoints Studio calls

**Column key**

- MUST: needed for the list, switch and create MVP.
- LATER: wanted, not blocking.
- SKIP: Supabase-cloud business features.

"Local" names the self-hosted route that already exists under `studio/pages/api/`. Schema names
are `components['schemas'][...]` in `packages/api-types/types/platform.d.ts`; [v1] means
`api-v1.d.ts`.

**Behaviour that applies to every endpoint**

- Errors are JSON with `message`.
- A 4xx is never retried except 429 (`studio/data/query-client.ts:30-60`).
- A 404 on a non-blocking query just leaves `data` undefined.

### 2.1 Shell, list and switch

| Pri | Method and path | Caller | Schema and key fields | Local |
|---|---|---|---|---|
| MUST | GET /platform/profile (`Version: 2`) | `data/profile/profile-query.ts:10` | `ProfileResponse_Output`: id, gotrue_id, username, primary_email, disabled_features? | `profile/index.ts` (fake user) |
| MUST | GET /platform/organizations | `data/organizations/organizations-query.ts:28` | `OrganizationResponse_Output[]`: id, slug, name, plan{id,name}, is_owner, restriction_status | `organizations/index.ts` |
| MUST | GET /platform/organizations/{slug}/projects?limit&offset&sort&search&statuses | `data/projects/org-projects-infinite-query.ts:45`, used by `OrganizationProjectSelector.tsx:110` | `OrganizationProjectsResponse_Output`: {pagination, projects[]} | **none** |
| MUST | GET /platform/projects?limit&offset&sort&search (`Version: 2`) | `data/projects/projects-infinite-query.ts:34` | `ListProjectsPaginatedResponse_Output`: {pagination, projects[]} | `projects/index.ts` (returns a bare array) |
| MUST | GET /platform/projects/{ref} | `data/projects/project-detail-query.ts:33` | `ProjectDetailResponse_Output`: id, ref, name, status, organization_id, cloud_provider, region, db_host, connectionString, restUrl, inserted_at | `projects/[ref]/index.ts` |
| MUST | GET /platform/projects/{ref}/status | `data/projects/project-status-query.ts:17`; `BuildingState.tsx:33` polls it every 4 s | untyped, `.status` is read | **none** |
| MUST | GET /platform/projects/{ref}/settings | `data/config/project-settings-v2-query.ts:27` | `ProjectSettingsResponse_Output`: db_host, db_name, db_port, db_user, jwt_secret?, app_config{endpoint, storage_endpoint}, service_api_keys[] | `projects/[ref]/settings.ts` |
| MUST | GET /v1/projects/{ref}/api-keys?reveal= | `data/api-keys/api-keys-query.ts:57` | [v1] `ApiKeyResponse_Output[]`: name, api_key, type (legacy, publishable, secret) | `v1/projects/[ref]/api-keys` |
| MUST | GET /platform/projects/{ref}/databases | `data/read-replicas/replicas-query.ts:44` | `DatabaseDetailResponse_Output[]`: identifier, db_host, db_port, db_user, connectionString, restUrl | `projects/[ref]/databases.ts` |
| MUST | GET /platform/projects/{ref}/config/supavisor | `data/database/supavisor-configuration-query.ts:17` | `SupavisorConfigResponse_Output[]`: db_host, db_port, db_user, pool_mode, connection_string | fork, `config/supavisor.ts` |
| MUST | POST /platform/pg-meta/{ref}/query | `data/sql/execute-sql-mutation.ts:102-168`; registry `data/query-sources/query-source-registry.ts:63` | `RunQueryBody` {query, parameters?, disable_statement_timeout?}, returns a row array. Header `x-connection-encrypted` | `pg-meta/[ref]/query/index.ts` |
| LATER | GET /platform/pg-meta/{ref}/{tables,views,policies,...} | `studio/pages/api/platform/pg-meta/[ref]/*.ts` (10 routes) | mostly replaced by `/query` | local, uses pg-meta's default DB |
| SKIP | GET /platform/profile/permissions | `data/permissions/permissions-query.ts:12` | `AccessControlPermission[]` | platform only |
| SKIP | GET /platform/organizations/{slug}, /entitlements, /billing/subscription, /usage | `organization-query.ts:25`, `entitlements-query.ts:30`, `org-subscription-query.ts:21`, `org-usage-query.ts:24` | billing and plan | subscription is local |
| SKIP | /platform/notifications, /projects-resource-warnings, /integrations, /telemetry/*, /v1/projects/{ref}/branches, /projects/{ref}/members, /database/{ref}/backups | (various) | all fail gracefully | |

### 2.2 Per-project feature pages

These already have local routes. Each one only has to honour `ref`.

| Pri | Method and path | Caller | Schema | Local |
|---|---|---|---|---|
| MUST | GET, PATCH /platform/auth/{ref}/config (+ /config/hooks, /templates/*) | `data/auth/auth-config-query.ts:21` | `GoTrueConfigResponse` (flat GOTRUE keys) | fork stage 1 |
| MUST | POST /platform/auth/{ref}/users; PATCH, DELETE …/users/{id}; POST …/invite, /recover, /otp, /magiclink | `data/auth/user-create-mutation.ts:18` and siblings | `CreateUserBody` | `auth/[ref]/*` |
| MUST | auth user list and count | `data/auth/users-infinite-query.ts:70-74` (SQL via pg-meta `/query`) | | through `/query` |
| MUST | /platform/storage/{ref}/buckets[/{id}[/objects/*]] | `data/storage/buckets-query.ts:52`, `bucket-*-mutation.ts` | `StorageBucketResponse_Output` | `storage/[ref]/*` |
| LATER | GET, PATCH /platform/projects/{ref}/config/{storage,postgrest,realtime,pgbouncer}; /storage/{ref}/credentials | `data/config/project-storage-config-query.ts:21`, `project-postgrest-config-query.ts:34`, `data/realtime/realtime-config-query.ts:36` | `StorageConfigResponse_Output`, `GetPostgrestConfigResponse_Output`, `RealtimeConfigResponse_Output` | fork stage 2 |
| LATER | GET or POST /platform/projects/{ref}/analytics/endpoints/{logs.all, usage.api-counts, service-health} | `data/logs/execute-analytics-sql.ts:55,67`; `analytics/project-log-stats-query.ts:39` | `AnalyticsResponse_Output` {result[], error?} | `analytics/endpoints/[name].ts` |
| LATER | GET /platform/projects/{ref}/api/rest; POST /api-keys/temporary; GET /run-lints; GET /content | `docs/project-json-schema-query.ts:79`, `temp-api-keys-query.ts:16`, `lint-query.ts:21`, `content-query.ts:60` | | local |
| LATER | /v1/projects/{ref}/functions/** (edge functions) | | | local, one folder |
| SKIP | /projects/{ref}/billing/addons, /disk, /infra-monitoring, /daily-stats, /load-balancers, /databases-statuses, /read-replicas/*, /service-versions, /wake, /db-password, /config/secrets | | | |

### 2.3 Create and lifecycle

| Pri | Method and path | Caller | Schema |
|---|---|---|---|
| MUST | POST /platform/projects | `data/projects/project-create-mutation.ts:57-82` | `CreateProjectBody`: name, organization_slug, db_pass, cloud_provider, db_region?, region_selection?, desired_instance_size?, data_api_*?, ... Returns `CreateProjectResponse_Output`: id, ref, name, status, organization_slug, endpoint, anon_key, service_key, inserted_at. After success the form goes to `/project/${res.ref}` (`ProjectCreationForm.tsx:407`). |
| LATER | DELETE /platform/projects/{ref} | `project-delete-mutation.ts:16` | `RemoveProjectResponse_Output` |
| LATER | POST /platform/projects/{ref}/pause, /restore; GET /pause/status | `project-pause-mutation.ts:12`, `project-restore-mutation.ts:19`, `project-pause-status-query.ts:19` | `PauseStatusResponse_Output` |
| LATER | POST /platform/projects/{ref}/restart | `project-restart-mutation.ts:19` | `RestartProjectBody` |
| SKIP | GET /platform/projects/available-regions; POST /organizations/{slug}/available-versions; …/members/reached-free-project-limit; /stripe/invoices/overdue | `organization-available-regions-query.ts:29` and siblings | |

**The upstream create form does not work self-hosted as-is.**

- Region resolution waits on `flagsLoaded` (`ProjectCreationForm.tsx:140,273,294`).
- The feature-flag provider never sets `hasLoaded` when `enabled` is false
  (`packages/common/feature-flags.tsx:141`, and `studio/pages/_app.tsx:185` passes
  `enabled={IS_PLATFORM}`).
- So in option B the button should open a fork-owned form instead: a new file, which cannot
  conflict with upstream.

## 3. How self-hosted Studio reaches backends today

All of these are process-wide env reads, and every `[ref]` route ignores its `ref`. The last
column is what has to come from the project registry instead.

| Backend | Env vars and where they are read | Users | Per-project? |
|---|---|---|---|
| Postgres via pg-meta | `STUDIO_PG_META_URL` (`lib/constants/index.ts:48-50`); `POSTGRES_HOST/PORT/DB/PASSWORD`, `POSTGRES_USER_READ_WRITE/READ_ONLY` (`lib/api/self-hosted/constants.ts:8-14`); `PG_META_CRYPTO_KEY` (`constants.ts:7`) | `getConnectionString` (`util.ts:27-31`) feeds `executeQuery` (`query.ts:28-45`, which sends `x-connection-encrypted` at :42). Also used by migrations, lints and the stage-2 postgrest and realtime modules. | **Yes**: the connection string. The pg-meta URL stays shared. |
| pg-meta GET routes | `pages/api/platform/pg-meta/[ref]/tables.ts:28-50` and siblings | They send no connection header, so pg-meta uses its own `PG_META_DB_*` (`deploy/coolify/docker-compose.yaml:496-500`) | **Yes**: add the header. |
| GoTrue admin, storage, REST, GraphQL | `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` (`lib/api/self-hosted-admin.ts:17-21`; `auth/[ref]/{invite,recover,magiclink,otp}.ts:25-27`; `projects/[ref]/api/rest.ts:22-25`; `api/graphql.ts:23-29`) | supabase-js admin client | **Yes**: the URL and the keys. |
| Public URLs | `SUPABASE_PUBLIC_URL` (`lib/constants/api.ts:1-11`; storage `objects/{sign,public-url}.ts`; `service-config/supavisor.ts:53`) | | **Yes** |
| API keys and JWT | `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` (`lib/api/self-hosted/api-keys.ts:33-64`, `settings.ts:40-50`); `AUTH_JWT_SECRET` (`constants.ts:20`) | | **Yes**, with one exception below. |
| Logs | `LOGFLARE_URL` (`lib/constants/api.ts:4-6`); `LOGFLARE_PRIVATE_ACCESS_TOKEN` (`lib/api/self-hosted/logs.ts:33,49`) | `logs.ts` already sends `project=<ref>` (:33) | Shared; filtering is LATER (§5). |
| Auth config (fork) | `GOTRUE_CONFIG_DIR` (`auth-config/render.ts:8,13`); `STUDIO_AUTH_STATE_DIR` (`state.ts:11,17`); `STUDIO_INTERNAL_URL` (`index.ts:212`) | writes `99_studio.env` and `auth-config.json` | **Yes**: a directory per ref. |
| Storage config (fork) | `STORAGE_CONFIG_DIR` (`service-config/storage.ts:40`); `storage-config.json` (:30) | | **Yes**: a directory per ref. |
| Pooler and Realtime admin (fork) | `SUPAVISOR_URL`, `POOLER_TENANT_ID` (`supavisor.ts:33,36`); `REALTIME_URL`, `REALTIME_TENANT_ID` (`realtime.ts:54,57`) | `PUT /api/tenants/<id>` | The URL is shared; **tenant id = ref**. |
| Edge functions, snippets | `EDGE_FUNCTIONS_MANAGEMENT_FOLDER` (`self-hosted/functions/index.ts:9-13`); `SNIPPETS_MANAGEMENT_FOLDER` | file system | LATER: a subfolder per ref. |

All `lib/...` and `pages/...` paths in this table are under `studio/`.

**Trap: `AUTH_JWT_SECRET` does two jobs today.**

- It is the project's JWT secret.
- It also signs the admin tokens for Supavisor and Realtime (`service-config/jwt.ts`), which must
  match those services' `API_JWT_SECRET` (`deploy/coolify/docker-compose.yaml:362,571`).
- In multi-project these split. Admin tokens use one shared `PLATFORM_ADMIN_JWT_SECRET`. The
  project JWT secret comes from the registry.

**Patch shape with the smallest diff.**

- One upstream patch in `studio/lib/api/apiWrapper.ts`: run the handler inside an
  `AsyncLocalStorage` context keyed by `req.query.ref`.
- One new module, `studio/lib/api/self-hosted/project-context.ts`. Its `currentProject()` returns
  the registry record, cached for 30 s.
- The leaf readers switch from env to `currentProject()`: `util.ts`, `self-hosted-admin.ts`,
  `api-keys.ts`, `settings.ts`, `logs.ts`, and the fork's `auth-config/*` and
  `service-config/*`. Signatures do not change, so callers do not change.
- When the registry is not configured, `currentProject()` returns the env-built `default`
  project, so behaviour is identical to today.

## 4. Options

### A. `IS_PLATFORM=true` and a new control-plane API

Studio is built with `NEXT_PUBLIC_IS_PLATFORM=true` and `NEXT_PUBLIC_API_URL=<control plane>`.
`apps/control-plane` implements `/platform/*` and `/v1/*`.

**Studio patches needed:** almost none in pages. The image build changes, and dashboard users
need a GoTrue of their own at `NEXT_PUBLIC_GOTRUE_URL`.

**What the control plane has to do:**

- Every MUST row in §2.1 and §2.3, in the paginated platform shapes.
- Every §2.2 route, because the local ones are switched off (`proxy.ts:13-19`). That is about 85
  routes under `pages/api/platform` and `pages/api/v1`. It includes porting the fork's stage 1 and
  stage 2 backends, the storage and auth admin proxies, logs, snippets and functions.
- A pg-meta proxy that decrypts the per-project connection string.
- Verify GoTrue JWTs and send CORS with credentials.
- Answer `/telemetry/feature-flags`, `/profile/permissions` and `/organizations/{slug}/entitlements`.
  Without these, features hidden by a missing entitlement stay hidden.

**Gains:** the native org and project UI, the native create form, BuildingState, and real users
and permissions.

**Costs:**

- The largest surface. The fork's existing value has to be rewritten, or extracted into a
  package.
- Every upstream change to platform types becomes a contract change.
- Platform-only UI (billing, usage, entitlements) has to be stubbed.

**Estimate: 25-35 days.**

### B. Keep `IS_PLATFORM=false` and add a project switcher

**Studio changes:**

- The `project-context` resolver from §3.
- `GET /platform/organizations/[slug]/projects` and the `/status` route, both new files.
- `projects/index.ts`, `projects/[ref]/index.ts` and `profile/index.ts` read from the registry.
- `ProjectDropdown.tsx:182` and `OrgProjectSwitcher.tsx:19,61` change `IS_PLATFORM` to
  `IS_PLATFORM || IS_MULTI_PROJECT`.

**Registry:** a table filled by hand or by a CLI. There is no create button.

**Size:** about 6 upstream-file patches of 1-3 lines each, plus about 10 fork-owned modules.

**Estimate: 5-7 days**, including verifying the shared services from §5 by hand for two projects.

### B+ (recommended): B plus a control plane for create, with no platform mode

- B as above. Studio's local `POST /platform/projects` and the status route call
  `apps/control-plane` over the internal network.
- `apps/control-plane` is a small Node service, deployed as its own Coolify service. It has no
  Studio code. It owns:
  - **Registry.** Postgres schema `_platform` in the shared `_supabase` database, the one
    Supavisor and Logflare already use (`deploy/coolify/docker-compose.yaml:209,567`).
  - **Tables.** `projects(ref, name, status, created_at)` and `project_secrets(ref, db_password, jwt_secret, anon_key, service_key, coolify_service_uuid)`.
    Secrets are encrypted with a key from env.
  - **Provisioner.** It renders a per-project compose (db, auth, rest, storage) from a template in
    `deploy/platform/project-compose.yaml`, then calls Coolify: `POST /api/v1/services` with base64
    `docker_compose_raw`, `project_uuid`, `server_uuid`, `environment_name` and
    `instant_deploy: true`. The response is `{uuid, domains}`. Then PATCH env and start the service.
  - **Tenant registration.** Supavisor, Realtime and Kong, per §5.
  - **Status.** `CREATING`, then `COMING_UP` while health checks run, then `ACTIVE_HEALTHY`.
    Studio's BuildingState already renders `COMING_UP`.
- **Create UI.** The dropdown's "New project" links to `/new/<slug>`. Under the flag, a fork-owned
  page `pages/new-project.tsx` (name and DB password only) is used, and one redirect is patched,
  so the upstream form is never needed.
- **Why not A:** B+ keeps all existing local routes and the fork backends working and does not
  need a dashboard GoTrue. Each upstream file touched is a 1-3 line patch behind a flag. Studio
  stays unauthenticated behind Kong basic auth, as today.

**Estimate: 13-17 days** (B 6 + control plane and provisioning 4 + shared-service registration
3 + create UI 1 + end-to-end hardening 2).

**Recommendation: B+.** Build B first: it is useful on its own, and it proves the per-ref
resolver and the shared-service wiring before any provisioning exists.

## 5. Shared services: multi-tenancy and registering a project

**Network prerequisite (all services).** Each Coolify service runs on its own Docker network, and
Coolify suffixes container names with the service UUID **[assumption]**. Shared services must
reach each project's db, auth, rest and storage. Plan:

- enable "Connect to Predefined Network" (the `coolify` network) on both the shared stack and each
  project service **[assumption]**;
- give project containers stable aliases, `<ref>-db`, `<ref>-auth` and so on.

Verify both on the server before M2.

| Service | Multi-tenant? | Register a project | Evidence |
|---|---|---|---|
| **postgres-meta** | **Yes, per request.** The target DB comes from the `x-connection-encrypted` header, which is AES with `PG_META_CRYPTO_KEY`. | Nothing to register. Studio sends the project's encrypted connection string. | `studio/lib/api/self-hosted/query.ts:28-45`, `util.ts:23-25`; `docker/docker-compose.yml:432` (`CRYPTO_KEY`) |
| **Supavisor** | **Yes, native.** Tenants live in `_supabase`. Clients pick a tenant by username `user.<tenant>` **[assumption: standard Supavisor]**. | `PUT /api/tenants/<ref>` with a Bearer HS256 token signed with `API_JWT_SECRET`. Body as in pooler.exs: `external_id`, `db_host`, `db_port`, `db_database`, `require_user: false`, `auth_query: "SELECT * FROM pgbouncer.get_auth($1)"`, `default_pool_size`, `default_max_clients`, `users: [{db_user: "pgbouncer", db_password, mode_type, pool_size, is_manager: true}]`. Use PUT for create too **[assumption: PUT upserts; else POST /api/tenants]**. | `docker/volumes/pooler/pooler.exs:9-30`; the fork's PUT at `studio/lib/api/self-hosted/service-config/supavisor.ts:66,299` |
| **Realtime** | **Yes, native.** The tenant comes from the **first label of the Host header**. That is why the container is named `realtime-dev.supabase-realtime` and Kong proxies to that host. | `POST /api/tenants` with `{tenant: {name, external_id: <ref>, jwt_secret, extensions: [{type: "postgres_cdc_rls", settings: {db_host, db_port, db_name, db_user, db_password, region, ...}}]}}` **[assumption: body shape from Realtime source, verify]**. Routing: Kong must send `Host: <ref>.supabase-realtime` per project (a Kong `upstream` with `host_header`, or a request-transformer) **[assumption]**. Keep `SEED_SELF_HOST` only for the `default` tenant, because the seed deletes and re-inserts it (FORK.md stage 2, "How it works" 3). | `docker/docker-compose.yml:285-286`; `docker/volumes/api/kong.yml:217-219`; `docker/volumes/api/envoy/lds.template.yaml:481,500`; `docker/CONFIG.md:926-927` (`SEED_SELF_HOST`, `SELF_HOST_TENANT_NAME`); fork PUT `realtime.ts:59,300` |
| **Kong** | **Partly.** DB-less declarative config. Routes are by path only today, and there is one consumer set (anon, service_role). | Generate `kong.yml` with, per project: routes with `hosts: [<ref>.<domain>]` for `/auth/v1`, `/rest/v1`, `/storage/v1`, `/realtime/v1`, `/graphql/v1`; consumers `anon-<ref>` and `service_role-<ref>` with the project's keys; ACL groups per ref so one project's key cannot pass another's routes. Reload with `kong reload` or the admin `POST /config` **[assumption: admin API not enabled today]**. Literal keys go in the file, because the entrypoint substitutes env for one project only. The public side needs a wildcard domain `*.<domain>` on the Kong service in Coolify **[assumption: wildcard TLS needs a DNS challenge]**. | `docker/volumes/api/kong.yml:7-21` (consumers), `:131-158,217-280,316,426-441` (routes); Coolify Kong binds `./volumes/api/kong.yml` (`deploy/coolify/docker-compose.yaml:52`) |
| **Logflare + vector** | **No in practice.** `LOGFLARE_SINGLE_TENANT=true` with fixed source names. vector routes by container name. | **LATER.** Have vector route by a Docker label (`pieowl.ref=<ref>`) and add `metadata.project`. Then make `logs.ts` filter by `project`. Studio already passes `project=<ref>` (`logs.ts:33`); whether Logflare's single-tenant endpoints honour it is **[assumption: probably not]**. Until then, project containers' logs do not match vector's routes and are dropped, so logs work only for `default`. | `deploy/coolify/docker-compose.yaml:216-217`; `docker/volumes/logs/vector.yml:32-39` (routes), `:158` (`db-default`), `:187-268` (sinks) |
| **storage-api** | Can run multi-tenant (`MULTI_TENANT=true`, tenant taken from `X-Forwarded-Host` by `REQUEST_X_FORWARDED_HOST_REGEXP`, admin API on `SERVER_ADMIN_PORT` 5001), but runs single-tenant today. | **Per-project instance** (already in the plan): `TENANT_ID=<ref>`, `DATABASE_URL` to the project DB, `AUTH_JWT_SECRET` set to the project's secret. MinIO stays shared, either with one bucket per project or with the shared bucket keyed by tenant id **[assumption: storage-api prefixes object keys with the tenant id]**. | `docker/CONFIG.md:946,960,962,970`; `deploy/coolify/docker-compose.yaml:438,443,465` |
| **imgproxy** | Stateless. | Nothing to register. Each storage-api points `IMGPROXY_URL` at the shared one. Image transforms read objects from MinIO **[assumption: verify the S3 source config]**. | `deploy/coolify/docker-compose.yaml:455` |
| **MinIO** | One server. | A bucket per project, `<ref>`, created by the control plane through the S3 API, plus a scoped key. | `deploy/coolify/docker-compose.yaml:375-410` |
| **Edge runtime** | No: one `SUPABASE_DB_URL` and one key set. | SKIP for the MVP, or an optional per-project container LATER. | `docker/docker-compose.yml:434,464` |

**Per-project files Studio writes, from fork stages 1 and 2.**

- Studio mounts one host directory, `/data/pieowl/projects` (an absolute bind).
- Each project compose mounts:
  - `/data/pieowl/projects/<ref>/gotrue:/etc/gotrue:ro` on auth;
  - `/data/pieowl/projects/<ref>/storage:/etc/studio-config:ro` on storage.
- The resolver sets `GOTRUE_CONFIG_DIR`, `STORAGE_CONFIG_DIR` and the state directory to
  `<root>/<ref>/...`.
- The template URL at `auth-config/index.ts:212` uses the ref.

## 6. Risks

1. **Coolify networking and naming.** Separate networks and UUID-suffixed names break every
   cross-service URL. This is the gating assumption, so check it first (M0).
2. **Realtime tenant routing through a shared Kong** depends on Host rewriting per project. If
   Kong cannot do it cleanly, the fallback is network aliases `<ref>.supabase-realtime` on the
   Realtime container, which needs a redeploy of the shared stack for each new project.
3. **Kong reload.** Regenerating DB-less config must be atomic and must not drop live sockets.
   A bad file takes down every project, so validate it with `kong config parse` before reload.
4. **Upstream drift.** The six patched upstream files (`apiWrapper.ts`, `ProjectDropdown.tsx`,
   `OrgProjectSwitcher.tsx`, `projects/index.ts`, `projects/[ref]/index.ts`, `profile/index.ts`)
   can conflict, and upstream can add env reads that the resolver misses. Mitigation: a test that
   greps `lib/api/self-hosted` for `process.env.(SUPABASE_|POSTGRES_|AUTH_JWT)` outside the
   resolver.
5. **`NEXT_PUBLIC_*` is build-time.** `IS_MULTI_PROJECT` must be baked into the fork image, so
   the server-side behaviour has to stay identical to today when the registry is not configured.
6. **Unauthenticated Studio.** One Kong basic-auth login now opens every project, and the
   registry holds every project's service key. That is acceptable for a single operator. A
   multi-user setup needs A or a real login.
7. **Resources.** Each project runs Postgres, GoTrue, PostgREST and storage-api, about
   0.5-1 GB RAM **[assumption]**. Cap the project count per server in the control plane.
8. **Secrets in plain text** in the Coolify env and on bind-mounted files (FORK.md already lists
   this for one project). Now it is N times over.
9. **Partial provisioning.** If Coolify succeeds and tenant registration fails, a project is left
   half-built. The control plane needs idempotent steps and a `FAILED` status that can be retried
   or deleted.

## 7. Build plan

Each milestone ends with a verify step. Nothing ships until its verify passes.

| # | Milestone | Verify |
|---|---|---|
| M0 | **Spike on the server.** Start a second db+auth+rest+storage stack by hand as a Coolify service. Confirm the networks, container names and aliases. Register it in Supavisor (PUT tenant) and Realtime (POST tenant). Add a host route in Kong by hand. | From the Supavisor container, `psql "postgres://postgres.<ref>:…@supavisor:6543/postgres"` connects. A realtime-js client on `<ref>.<domain>` receives a broadcast. `curl https://<ref>.<domain>/rest/v1/ -H apikey:<anon>` returns 200 while project `default`'s key gets 401. |
| M1 | **Resolver, no UI.** Add `project-context.ts`, patch `apiWrapper.ts`, migrate the leaf readers, and split the admin secret from the project secret. The registry is a JSON file or table holding `default` plus the M0 project. | Unit tests: with the registry unset, every existing `*.test.ts` passes unchanged. With two entries, `executeQuery` and the admin client hit the right DB and URL for each ref. `/project/<m0ref>/editor` lists that project's tables. |
| M2 | **Switcher.** Add the org-projects and status routes, read the registry in projects, profile and detail, and add the `IS_MULTI_PROJECT` gates. | The header dropdown lists both projects. Switching changes Table Editor, SQL Editor, Auth users, Storage buckets, API keys and Connect strings. The same pages for `default` still match production. |
| M3 | **Per-project fork configs.** Give auth-config and service-config ref-scoped directories and tenant ids, and add the bind mounts. | Saving SMTP on project B writes `/data/pieowl/projects/B/gotrue/99_studio.env`, B's auth logs `reloading api with new configuration`, and A's file is untouched. Pooler and Realtime settings change B's tenant only. |
| M4 | **`apps/control-plane`: registry and Coolify provisioner.** Template compose, `POST /api/v1/services`, env, start, health polling, idempotent steps. | Integration test against Coolify on a staging server: create, then reach `ACTIVE_HEALTHY` within N minutes, then delete. A re-run after a failure partway through ends in a clean state. |
| M5 | **Tenant registration in the control plane.** Supavisor, Realtime, Kong config and reload, and a MinIO bucket. | The same checks as M0 pass for a freshly created project with no manual steps. `kong config parse` gates every reload. |
| M6 | **Create button.** Local `POST /platform/projects` calls the control plane; add the fork's `new-project` page; BuildingState handles `COMING_UP`. | Clicking "New project", entering a name and saving leads to the building screen and then the project home. The new project shows in the dropdown, and its Table Editor works. |
| M7 (LATER) | **Logs per project.** Route vector by label and filter by project. | Logs Explorer on project B shows only B's auth and REST lines. |
| M8 (LATER) | **Delete, pause and restart** through Coolify stop, start and delete, plus tenant cleanup. | After a delete, the Supavisor and Realtime tenants, the Kong routes and the MinIO bucket are gone, and the Coolify service is removed. |

**Out of scope:** billing, org members, usage and entitlements, branches, read replicas, and
multiple orgs (all projects live in one org, `default-org-slug`).

## 8. M0 findings (2026-10-12, server B, Coolify 4.4.6)

**Cross-service networking — verified.** Two probe services in Coolify, both with
`connect_to_docker_network: true` (API `PATCH /api/v1/services/{uuid}`):
- each container sits on its own service network (aliases `probe` and `probe-<uuid>`) and on
  the shared `coolify` network with **only** the full alias `probe-<uuid>`;
- from service one, `probe-<uuid-of-two>` resolves on `coolify` and pings in 0.14 ms;
- the short name `probe` resolves to the container's own service network only, so identical
  short names in different projects (`supabase-db`, `supabase-auth`) cannot collide;
- a service without the flag is not reachable from a connected one (isolation kept).

Consequence for the design: the shared stack and every project stack set
`connect_to_docker_network: true`; shared services address project containers by
`<service>-<project-service-uuid>` (e.g. `supabase-db-<uuid>`), which the control plane
knows from the Coolify API response at creation time. No custom Docker networks needed.

**Shared Supavisor and Realtime — verified** (files in `spike/`: `platform.yaml` = shared
stack with its own metadata Postgres, `project.yaml` = one light project DB, `register.sh` =
the registration calls; run on B, results 2026-10-12):

| Check | Result |
|---|---|
| Supavisor `PUT /api/tenants/proj1` (admin JWT, HS256) | 201 |
| `psql -h supavisor-<uuid> -p 6543 -U postgres.proj1` → project DB | query ok (server = project container on `coolify`) |
| Realtime `POST /api/tenants` with `postgres_cdc_rls` → project DB | 201, `/health` healthy |
| WebSocket upgrade, `Host: proj1.<anything>` + anon JWT of the project | 101 |
| WebSocket upgrade, `Host: other.<anything>` | 403 |

So both services are multi-tenant as the spec assumed, with one admin JWT secret for the
platform and a per-project JWT secret stored in the Realtime tenant. Supavisor and Realtime
metadata live in a small platform Postgres (`_supabase` DB and `_realtime` schema), not in any
project DB. **Shared Kong — verified** (`spike/kong-shared.yaml`, `spike/kong-project.yaml` ×2,
`spike/kong-test.sh`): one DB-less Kong, one service + route per project matched by `hosts`,
one `key-auth` consumer per project key with an `acl` group, `acl allow: [<ref>]` on the route.

| Check | Result |
|---|---|
| `Host: p1…` + p1 anon key → p1 PostgREST | 200, rows from project one's DB |
| `Host: p2…` + p2 anon key → p2 PostgREST | 200, rows from project two's DB |
| p2 key on p1 host / p1 key on p2 host | 403 `You cannot consume this service` |
| no key | 401 |
| 300 sequential requests while the config is rewritten and `kong reload`ed twice | 300 × 200, 0 failures |
| broken file → `kong config parse` before reload | rejected, reload skipped, traffic unaffected |

Reload procedure for the control plane: write the new declarative file, `kong config parse`,
then `kong reload`; never reload an unparsed file. **M0 is complete.**

## 9. M1 status (2026-10-12): resolver built, server check pending

**What was built.** Commits `b9de5f75..6ff66ebc` on `platform/control-plane`. All paths are under `studio/`.

- `lib/api/self-hosted/project-context.ts` (new, fork-owned). Loads the registry (re-read at most
  every 30 s), keeps the request's project in `AsyncLocalStorage`, and exports `projectEnv(name)`,
  `projectPostgres()`, `projectJwtSecret()`, `adminJwtSecret()`, `isMultiProject()`.
- `lib/api/self-hosted/multi-project.ts` (new, fork-owned). The multi-project branch of the upstream
  readers that hold a module constant or a singleton: connection string, one admin client per
  project, settings fields, project detail.
- Upstream patches, each behind `isMultiProject()` or a `process.env.X` → `projectEnv('X')` swap
  (added/removed lines):

  | File | +/- |
  |---|---|
  | `lib/api/apiWrapper.ts` | +3 −1 |
  | `lib/api/self-hosted/util.ts`, `settings.ts` | +3 −0 each |
  | `lib/api/self-hosted-admin.ts` | +4 −0 |
  | `lib/api/self-hosted/api-keys.ts` | +5 −4 (4 swaps) |
  | `pages/api/platform/projects/[ref]/index.ts` | +3 −0 |
  | `pages/api/platform/auth/[ref]/{invite,magiclink,otp,recover}.ts` | +3 −2 each |
  | `pages/api/platform/projects/[ref]/api/rest.ts` | +3 −2 |
  | `pages/api/platform/projects/[ref]/api/graphql.ts` | +4 −3 |
  | `pages/api/platform/projects/[ref]/{api-keys/temporary,config/index}.ts` | +2 −1 each |
  | `pages/api/platform/storage/[ref]/buckets/[id]/objects/{sign,sign-multi,public-url}.ts` | +2 −1 each |

- Fork modules switched to the resolver: `service-config/{supavisor,realtime,postgrest,storage}.ts`,
  `auth-config/{index,render,state}.ts`. `turbo.jsonc` gained `STUDIO_PROJECT_REGISTRY` and
  `PLATFORM_ADMIN_JWT_SECRET`.
- Tests: `lib/api/self-hosted/project-context.test.ts` (25),
  `tests/pages/api/platform/multi-project.test.ts` (18, real route handlers, MSW),
  `lib/api/self-hosted/project-env-guard.test.ts` (8, risk 4).

**How it behaves.**

- `STUDIO_PROJECT_REGISTRY` unset: `projectEnv` is `process.env`, `apiWrapper` calls the handler
  directly, and no `isMultiProject()` branch is taken.
- Set: `apiWrapper` resolves `req.query.ref` (else `body.projectRef`, which the AI routes send).
  - An unknown ref is a 404 `{ error: { message: "Project <ref> not found" } }`, and no backend is
    called.
  - A route that names no project runs without one. Any project reader it reaches throws, and
    `apiWrapper` answers 500 with the message. It never falls back to `default`.
  - `default` reads its registry `env`, else the container environment.
  - Any other project reads only its own `env`. `POSTGRES_HOST`, `POSTGRES_PASSWORD`,
    `SUPABASE_URL`, `SUPABASE_PUBLIC_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY` and
    `AUTH_JWT_SECRET` are required, so a missing one fails at load and never reaches `default`'s
    backend.
  - Derived when not set: tenant ids = ref; GoTrue, storage and state directories =
    `<projectsDir>/<ref>/{gotrue,storage,state}`.
- Admin secret: Supavisor and Realtime admin tokens are signed with `adminJwtSecret()`, which is
  `PLATFORM_ADMIN_JWT_SECRET`, else `AUTH_JWT_SECRET`, else the CLI default. The project's
  `AUTH_JWT_SECRET` is what settings, `config/index.ts` and the Data API config report.

**Registry file** (M1; M4 moves it into `_platform`). Placeholders in `<>`:

```json
{
  "projectsDir": "/data/pieowl/projects",
  "projects": {
    "default": {},
    "<m0ref>": {
      "name": "<display name>",
      "env": {
        "POSTGRES_HOST": "supabase-db-<project-service-uuid>",
        "POSTGRES_PASSWORD": "<db password>",
        "SUPABASE_URL": "http://<internal gateway for this project>:8000",
        "SUPABASE_PUBLIC_URL": "https://<m0ref>.<domain>",
        "SUPABASE_ANON_KEY": "<anon jwt>",
        "SUPABASE_SERVICE_KEY": "<service_role jwt>",
        "AUTH_JWT_SECRET": "<project jwt secret>"
      }
    }
  }
}
```

Allowed `env` names are the per-project ones in `PROJECT_ENV_NAMES` plus any `GOTRUE_*`. Anything
else is rejected, so a typo cannot pass unnoticed. Refs must match `^[a-z0-9][a-z0-9-]{0,62}$`. An
error message names the file, the project and the missing keys, never a value.

**Tests** (`NODE_ENV=test vitest --run`, whole studio suite):

| | Files | Tests | Failed |
|---|---|---|---|
| Before (a6ad26cf) | 726 | 8446 | 0 |
| After (6ff66ebc) | 729 | 8497 (8446 old + 51 new) | 0 |

`tsc --noEmit` passes. ESLint on the touched files gives 0 errors, and its only warnings are the
existing `import/no-anonymous-default-export` warnings on the upstream route files.

**Deviations from this spec.**

- §3 described `currentProject()` returning a record. It is `projectEnv(name)` instead: an entry
  is written in the env names Studio already reads, so each upstream patch is a token swap.
- §3 and §6 counted six upstream files for all of B. M1 alone patches 17, because 11 route files
  read `process.env.SUPABASE_*` directly instead of going through the leaf helpers.
- The M3 items that guard against cross-project writes were done now: tenant ids and the
  per-ref GoTrue, storage and state directories. Otherwise a save on project B would rewrite
  `default`'s `99_studio.env`. M3 keeps the bind mounts, compose and the server check.
- `projects/[ref]/index.ts` was planned for M2. It is needed now because the dashboard takes the ref
  for later calls from that response, not from the URL.

**Deferred** (each pinned in `project-env-guard.test.ts` with its reason):

- **M2**
  - `projects/[ref]/databases.ts` and `props/project/[ref]/api.ts` still report `default`'s
    host, port and REST URL. These feed the Connect strings.
  - The pg-meta GET routes (`pg-meta/[ref]/{tables,views,…}`) send no connection header. Nothing in
    `data/` calls them.
  - The `apiKey` header in `apiHelpers.ts`.
  - MCP (`pages/api/mcp`) has no ref. Under a registry its database calls throw.
- **M3**
  - The Realtime settings read `_realtime.tenants` over pg-meta from the project's database. A
    shared Realtime keeps that table in the platform database (§8), so for other projects the read
    falls back to the admin API and logs a warning.
  - `PGRST_DB_SCHEMAS` (`DEFAULT_EXPOSED_SCHEMAS`) is still read once, from the container.
- **Later**
  - The edge-functions test route.
  - Logs (M7).
  - Functions and snippets folders.

**Not verified.**

- `/project/<m0ref>/editor` on the server. That needs a Studio image from this branch, a registry
  file holding the M0 project, and a value for `SUPABASE_URL` that reaches that project's
  auth/rest/storage from Studio.
- What `SUPABASE_URL` should be for a non-default project. The shared Kong routes by host, so the
  project needs either its own internal gateway or a Kong route that matches an internal host.

## 10. Decisions after M1 (2026-10-12)

- **`SUPABASE_URL` of a non-default project** is its public gateway URL,
  `https://<ref>.<PROJECT_DOMAIN_SUFFIX>` (wildcard DNS → Traefik on the app server → shared
  Kong on the database server over WireGuard). Studio's server-side GoTrue/storage calls take
  that hairpin; the traffic is admin-only and small, and it needs no per-project internal
  gateway. Revisit only if latency matters.
- **Branch images.** `studio-fork-publish.yml` moves `latest` only on `main`; a run dispatched
  on a branch is tagged with the branch name (e.g. `platform-control-plane`), so running
  stacks that pull `latest` never get unreviewed code.
- **Kong config updates** go through Kong's admin API (`POST /config`, DB-less), which
  validates before applying — the control plane needs no Docker socket.

## 11. M2/M3 status (2026-10-12): switcher, M1 leftovers, registry from the control plane

**What was built.** Commits after `3751f58a` on `platform/control-plane`. Paths under `studio/`.

- **Registry from the control plane** (`lib/api/self-hosted/control-plane-registry.ts`, new).
  `STUDIO_PROJECT_REGISTRY_URL` + `STUDIO_PROJECT_REGISTRY_TOKEN` + `STUDIO_PROJECT_DOMAIN_SUFFIX`
  replace the JSON file (setting both is an error). Contract coded against
  `platform/cp-service` `apps/control-plane/src/server.ts`: `GET /projects`, then
  `GET /projects/<ref>/secrets` for each project that has a `coolify_service_uuid`, bearer token,
  5 s timeout per call. Each project becomes the M1 entry shape:
  - `POSTGRES_HOST = supabase-db-<coolify_service_uuid>`, `POSTGRES_PASSWORD = db_password`;
  - `SUPABASE_URL = SUPABASE_PUBLIC_URL = https://<ref>.<suffix>` (§10);
  - `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY`, `AUTH_JWT_SECRET` from the secrets;
  - status `CREATING`/`COMING_UP` → `COMING_UP`, `ACTIVE_HEALTHY` → `ACTIVE_HEALTHY`,
    `FAILED` → `INIT_FAILED`, anything else → `UNKNOWN`.
  - Cached 10 s; concurrent requests share one load. A failed refresh keeps the last good
    registry for another 10 s and logs `[project-registry] <path> answered <status>` (never the
    token or a body). With no good registry yet the request fails (500 with the message). An
    unknown ref is still a 404; nothing falls back to `default`.
  - A project without a stack yet (no uuid) is listed, and `/status` and the detail answer
    `COMING_UP`, but `projectEnv` throws for any `REQUIRED_ENV` name ("Project <ref> is not ready
    (COMING_UP): it has no POSTGRES_HOST yet"), so none of its backend reads can reach `default`'s.
  - `runWithProject` is now async (the control plane is read over HTTP); `listProjects()` is new.
- **M2 switcher.**
  - New fork routes (each with a TanStack mirror; `routeTree.gen.ts` regenerated with
    `@tanstack/router-generator`, identical output for the existing routes):
    `pages/api/platform/organizations/[slug]/projects.ts` (paged `OrganizationProjectsResponse`,
    `limit`/`offset`/`sort`/`search`/`statuses`, 404 for any slug but `default-org-slug`; each
    project's primary database has `identifier = ref`) and `pages/api/platform/projects/[ref]/status.ts`.
  - `lib/api/self-hosted/project-list.ts` (new) builds both lists; `default` keeps id 1.
  - `IS_MULTI_PROJECT = NEXT_PUBLIC_IS_MULTI_PROJECT === 'true'` in `lib/constants/multi-project.ts`
    (new). The publish workflow passes it only for a manual run with `multi_project: true`
    (Dockerfile `ARG` in `build-next`); pushes to `main` build it off.
- **M1 leftovers (§9 "Deferred, M2").**
  - `projects/[ref]/databases.ts` and `props/project/[ref]/api.ts`: host, port, REST URL, keys and
    `identifier` of the request's project (the Connect sheet matches the primary database by
    `identifier === ref`).
  - The ten `pg-meta/[ref]` GET routes send the project's encrypted connection string
    (`withProjectConnection` in `multi-project.ts`) under a registry; single-project they forward the
    request headers as before.
  - `apiHelpers.ts`'s `apiKey` header is the project's service key. This was a real bug for
    projects other than `default`: Kong's key-auth reads `apikey` before `Authorization`, so
    invite/OTP/recover/magic link on project B carried `default`'s key and would get Kong's ACL 403.
  - **MCP: refused under a registry** (`pages/api/mcp`, 501 "The MCP server is not available when
    Studio serves several projects…"). Chosen over resolving a `?project_ref=` because the MCP tools
    also read `SUPABASE_PUBLISHABLE_KEY`, the project settings and the exposed schemas straight from
    `default`; resolving a ref would have needed all of those made per-project first, and a missed
    one would answer for the wrong project. Without a registry MCP is unchanged.
- **M3.**
  - Realtime settings: under a registry every project but `default` reads its tenant from the
    shared Realtime admin API only (`GET /api/tenants/<ref>`, admin JWT), without the
    `_realtime.tenants` query and without the degraded-mode warning. `default` keeps the table read.
  - `PGRST_DB_SCHEMAS` is a per-project registry name; the Data API settings and
    `getExposedSchemas` fall back to the project's own value (default `public,graphql_public`).
  - Confirmed with route tests: saving proj1's auth config writes only
    `<projectsDir>/proj1/gotrue/99_studio.env` and `<projectsDir>/proj1/state/auth-config.json`;
    a later save on `default` leaves proj1's file byte-identical.
- **Env guard (risk 4)** now reads every name in `PROJECT_ENV_NAMES` plus `GOTRUE_*`, pins
  `DEFAULT_EXPOSED_SCHEMAS`, adds six gated files (`mcp`, `profile`, `projects`, `databases`,
  `props`), and fails if any `pg-meta/[ref]` GET route stops wrapping its headers. The wider scan
  found one more direct read: `pages/api/get-s3-keys.ts` (CLI-only S3 keys, no caller in the
  dashboard), pinned as "later".

**Upstream patches in this round** (added/removed lines):

| File | +/- |
|---|---|
| `components/layouts/AppLayout/ProjectDropdown.tsx` | +3 −1 |
| `components/interfaces/App/CommandMenu/OrgProjectSwitcher.tsx` | +3 −1 |
| `pages/api/platform/projects/index.ts` | +7 −1 |
| `pages/api/platform/profile/index.ts` | +3 −0 |
| `pages/api/platform/projects/[ref]/databases.ts` | +6 −2 |
| `pages/api/platform/props/project/[ref]/api.ts` | +5 −2 |
| `pages/api/platform/pg-meta/[ref]/*.ts` (10 GET routes) | +2 −1 each |
| `pages/api/mcp/index.ts` | +2 −0 |
| `lib/api/apiHelpers.ts` | +2 −1 |
| `Dockerfile` | +2 −0 |
| `routeTree.gen.ts` (generated) | +45 −0 |

Fork-owned files changed: `project-context.ts`, `multi-project.ts`, `service-config/{postgrest,realtime}.ts`,
`turbo.jsonc`, `.github/workflows/studio-fork-publish.yml`.

**Tests** (`NODE_ENV=test vitest --run`, whole studio suite, compared by test id):

| | Files | Tests | Failed |
|---|---|---|---|
| Before (3751f58a) | 729 | 8497 | 0 |
| After (this round) | 734 | 8569 (8497 old + 72 new) | 0 |

By test id: none of the 8497 old tests is missing or changed status.

New tests: `control-plane-registry.test.ts` (13), `project-context.test.ts` (+15),
`tests/pages/api/platform/project-switcher.test.ts` (17), `multi-project.test.ts` (+11),
`tests/pages/api/mcp/multi-project.test.ts` (3), `realtime.test.ts` (+3), `project-env-guard.test.ts`
(+6), `ProjectDropdown.multi-project.test.tsx` (2), `OrgProjectSwitcher.test.tsx` (2).
`tsc --noEmit` passes. ESLint on the touched files: 0 errors; the warnings are the existing
`import/no-anonymous-default-export` and `no-explicit-any` ones in upstream route files.

**Deviations.**

- `GET /platform/projects` answers the paginated shape to any `Version: 2` caller, with or without a
  registry. Before, it gave those callers a bare array they could not read; no self-hosted page
  sent `Version: 2` until the command-menu gate, so nothing that worked changes.
- `OrgProjectSwitcher.tsx`: only the project query (line 19) is gated. §4 B also named line 61, the
  organizations command; its target pages are platform-only, and there is one organization.
- The `IS_PLATFORM` → `|| IS_MULTI_PROJECT` gates are 3-line patches (import, comment, line).
- The header's "New project" link still follows upstream's `projects:create` feature flag and
  leads to the upstream form, which does not work self-hosted (§2.3). Until M6, run a multi-project
  Studio with `ENABLED_FEATURES_PROJECTS_CREATE=false` to hide it.
- `projectsDir` with the control plane is the default `/data/pieowl/projects`; no env sets it.

**Not verified.** Nothing ran on a server. The M2 verify (switching changes Table Editor, SQL,
Auth users, Storage, API keys and Connect strings; `default` still matches production) needs an image
built with `multi_project: true`, a reachable control plane or registry file, and Kong routes for
the second project's host.

**What remains for M6 (create UI).**

- Local `POST /platform/projects` → control plane `POST /projects {name}`; answer
  `CreateProjectResponse` shape (`ref`, `name`, `status`, `endpoint`, keys).
- After a create, drop the 10 s registry cache (or re-read on a miss) so `/project/<ref>` does not
  404 for up to 10 s.
- The fork's `pages/new-project.tsx` (name, DB password) and the one redirect from `/new/<slug>`;
  then turn `projects:create` back on.
- BuildingState already polls `/status`; `COMING_UP` → `ACTIVE_HEALTHY` is served by the
  status route, and `INIT_FAILED` needs a message and a retry (`POST /projects {ref}`).
- MCP per project (resolve `?project_ref=`) once the MCP tools' reads go through the resolver.

## 12. M6 status (2026-10-12): the create button, Studio side

**What was built.** Commits `121777ad..3b1f6323` on `platform/control-plane`. Paths under `studio/`.
Contract coded against `platform/cp-service` `apps/control-plane/src/server.ts`.

- **Server** (`lib/api/self-hosted/project-lifecycle.ts`, new; writes added to
  `control-plane-registry.ts`; `controlPlaneConfig()` and `invalidateProjectRegistry()` added to
  `project-context.ts`). Each route is one control-plane call with the bearer token, then the cached
  registry is invalidated so the next request sees the change (a load already in flight is neither
  joined nor cached; the old list stays as the "last good" fallback).

  | Local route | Control plane | Answer |
  |---|---|---|
  | `POST /platform/projects {name, …}` | `POST /projects {name}` (15 s timeout); every other field, `db_pass` included, is dropped | 201 `CreateProjectResponse`: `ref`, `name`, `status` (mapped, so `COMING_UP`), `endpoint`, `inserted_at`, `organization_slug: default-org-slug`; `id: 0`, `anon_key`/`service_key: ''` (nothing reads them) |
  | `POST /platform/projects/{ref}/retry` (new, fork) | `POST /projects {ref}` | 202 `{ref, status: COMING_UP}` (`ACTIVE_HEALTHY` if it already runs) |
  | `DELETE /platform/projects/{ref}` | `DELETE /projects/<ref>` (120 s timeout: it runs every step before answering) | 200 `{id: 0, ref, name}` |

  - Errors are `{ message }`, the platform shape `data/fetchers.ts` `handleError` reads; the
    `{ error: { message } }` of the other self-hosted routes reaches the user as an unspecified error.
    The control plane's 400/404/409 keep their status and its `error` text (e.g. "Project <ref> is
    being provisioned"); a 401/403, a 5xx, a timeout or no connection is a 502 naming the call
    (`control plane POST /projects answered 500`), never the token or a body.
  - Name: trimmed, 1-64 chars, else 400 without a call. `default` cannot be retried or deleted (400).
    An unknown ref is still `apiWrapper`'s 404, without a call.
  - No registry: unchanged (405 for POST and DELETE). A registry file: 501 "… only with the control
    plane as its registry (STUDIO_PROJECT_REGISTRY_URL)".
- **Create UI.**
  - `pages/new-project.tsx` (+ TanStack mirror `routes/new-project.tsx`), laid out like `/new/[slug]`,
    form in `components/interfaces/MultiProject/NewProjectForm.tsx`: one field, upstream's name rules
    (`ProjectCreation.schema.ts`, 3-64 chars), a note that the control plane generates and keeps the
    DB password, the error inline. Uses upstream's `useProjectCreateMutation` (with `dbPass: ''`,
    which the route drops) and then `router.push('/project/<ref>')`. Without the flag the page sends
    the visitor to `/`.
  - The one redirect: `pages/new/[slug].tsx` renders `RedirectToNewProject` under the flag, so every
    upstream "New project" link (dropdown, org home, empty states) ends on the fork form and
    `ProjectCreationForm` never mounts. The header dropdown also links to `/new-project` directly.
  - `projects:create` needed no patch: it is a runtime feature, on unless the profile or
    `ENABLED_FEATURES_PROJECTS_CREATE=false` turns it off (`packages/common/enabled-features`). Drop
    that variable, which §11 suggested until M6.
- **After create.** `/project/<ref>` loads; the detail route reports `COMING_UP` (`CREATING` and
  `COMING_UP` map to it, §11) and the detail query re-polls every 5 s while it is
  (`data/projects/project-detail-query.ts:108-116`).
  - Under the flag, `ProjectLayout`'s `ContentWrapper` shows `components/interfaces/MultiProject/ProvisioningState.tsx`
    on every page that needs the database, **the home included**, for `COMING_UP`, `UNKNOWN` and
    `INIT_FAILED`. For the first two that is upstream's `BuildingState`, which polls
    `GET /platform/projects/{ref}/status` every 4 s (`BuildingState.tsx:33-40`,
    `project-status-query.ts:17`, i.e. the M2 status route) and reloads the project on
    `ACTIVE_HEALTHY`, after which the home renders. Settings, logs and functions pages stay reachable.
  - `INIT_FAILED`: a failed screen with **Retry** (`data/projects/project-retry-mutation.ts` →
    the retry route; on success the cached detail is set to `COMING_UP` so the building screen takes
    over) and **Delete project**.
- **Delete** (cheap, so done): Settings → General gets `MultiProjectDeletePanel` under the flag for
  every project but `default`; it and the failed screen open `MultiProjectDeleteDialog`, upstream's
  `TextConfirmModal` with the typed project name and upstream's `useProjectDeleteMutation`, then go
  to `/project/default`. Upstream's `DeleteProjectModal` is not reused: the local subscription stub
  says `enterprise`, so it demands a cancellation reason and posts an exit survey to a platform route
  that does not exist here (an error toast after every delete).

**Upstream patches in this round** (added/removed lines):

| File | +/- |
|---|---|
| `pages/api/platform/projects/index.ts` | +3 −0 |
| `pages/api/platform/projects/[ref]/index.ts` | +3 −0 |
| `routes/api/platform/projects/index.ts`, `routes/api/platform/projects/$ref/index.ts` | +1 −1 each |
| `pages/new/[slug].tsx` | +5 −0 |
| `components/layouts/AppLayout/ProjectDropdown.tsx` | +2 −1 |
| `components/layouts/ProjectLayout/index.tsx` | +9 −0 |
| `pages/project/[ref]/settings/general.tsx` | +4 −0 |
| `routeTree.gen.ts` (generated, `@tanstack/router-generator`) | +43 −0 |

New fork files: `lib/api/self-hosted/project-lifecycle.ts`, `pages/api/platform/projects/[ref]/retry.ts`
(+ mirror), `pages/new-project.tsx` (+ mirror), `data/projects/project-retry-mutation.ts`,
`components/interfaces/MultiProject/{NewProjectForm,RedirectToNewProject,ProvisioningState,MultiProjectDeletePanel,MultiProjectDeleteDialog}.tsx`.
Fork files changed: `control-plane-registry.ts`, `project-context.ts`.

**Tests** (`NODE_ENV=test vitest --run`, whole studio suite, compared by test id):

| | Files | Tests | Failed |
|---|---|---|---|
| Before (5d01706a) | 734 | 8569 | 0 |
| After (3b1f6323) | 740 | 8617 (8569 old + 48 new) | 0 |

By test id: none of the 8569 old tests is missing or changed status. The env guard is green.

New tests: `tests/pages/api/platform/project-lifecycle.test.ts` (18: real handlers, MSW control
plane — create, name validation, 400/401/500/unreachable mapping, no-token-in-body, the new project
visible at once, retry, delete, `default` refused, no registry and registry file unchanged),
`project-context.test.ts` (+3, invalidation), `NewProjectForm.test.tsx` (5: validation, submit
body, redirect, error shown), `new-project-routing.test.tsx` (4: flag on/off for both pages),
`ProjectDropdown.multi-project.test.tsx` (+2: link target), `ProvisioningState.test.tsx` (5:
building vs failed, retry, delete), `MultiProjectDeletePanel.test.tsx` (2),
`ProjectLayout/index.multi-project.test.tsx` (9: provisioning on home/editor, settings reachable,
flag off unchanged). `tsc --noEmit` passes. ESLint on the touched files: 0 errors; warnings are the
existing `import/no-anonymous-default-export` on the two upstream route files, one existing
`exhaustive-deps` in `ProjectLayout/index.tsx`, and `no-explicit-any` in the `ui` mocks copied from
`ProjectLayout/index.test.tsx`.

**Deviations.**

- §4 B+ said the page asks for a name and a DB password; it asks for the name only, because the
  control plane generates every secret. Nothing in self-hosted Studio shows the password; it is in
  the control plane (`GET /projects/<ref>/secrets`).
- The "one redirect" is a component in `pages/new/[slug].tsx`, not a `next.config` redirect, so it
  also catches client-side navigation and the TanStack build.
- Upstream shows a building project's home as a dimmed dashboard whose reads all fail for a project
  without a stack; under the flag the home shows `BuildingState` too.
- Errors of the three lifecycle routes are `{ message }` (above), unlike the other fork routes.
- Delete (M8's Studio half) is done; the control plane's `DELETE` already does the cleanup.

**Known gaps (LATER).**

- The failed screen does not say which step failed or why: the control plane's `step` and
  `last_error` are not carried through the registry. It points to the control plane's log.
- Retry race: if Studio re-reads the registry before the control plane has flipped `FAILED` to
  `CREATING` (milliseconds), the detail can read `INIT_FAILED` again for up to 10 s; pressing
  Retry again joins the run already in flight, so it is harmless.
- `BuildingState` is upstream's: its API keys card cannot load until the project has a stack
  (`projectEnv` refuses "not ready"), and it links to Supabase support.
- `UNKNOWN` (which also covers the control plane's `DELETING`) shows the building screen.
- MCP per project (resolve `?project_ref=`) is still refused under a registry (§11).

**Running Studio against the control plane.**

- Build arg: `NEXT_PUBLIC_IS_MULTI_PROJECT=true` (Dockerfile `ARG` in `build-next`; the publish
  workflow sets it for a manual run with `multi_project: true`).
- Studio container, runtime:
  - `STUDIO_PROJECT_REGISTRY_URL=http://control-plane-<platform-service-uuid>:8080` — the control
    plane on the shared `coolify` network (§8: only the full alias resolves across services; the
    control plane's `PORT` defaults to 8080). `STUDIO_PROJECT_REGISTRY` must not be set.
  - `STUDIO_PROJECT_REGISTRY_TOKEN` = the control plane's `CONTROL_PLANE_TOKEN`.
  - `STUDIO_PROJECT_DOMAIN_SUFFIX` = the control plane's `PROJECT_DOMAIN_SUFFIX` (projects are
    `https://<ref>.<suffix>`).
  - `PLATFORM_ADMIN_JWT_SECRET` = the control plane's `PLATFORM_ADMIN_JWT_SECRET`, the shared
    Supavisor and Realtime `API_JWT_SECRET`.
  - Not `ENABLED_FEATURES_PROJECTS_CREATE=false`.
  - Unchanged: `default`'s own env (`POSTGRES_*`, `SUPABASE_*`, `AUTH_JWT_SECRET`, `PG_META_CRYPTO_KEY`,
    …), `SUPAVISOR_URL`/`REALTIME_URL` pointing at the shared services, the fork's
    `STUDIO_INTERNAL_URL`, and the `/data/pieowl/projects` bind mount from M3 (per-project GoTrue,
    storage and state directories).
  - Studio must be on the `coolify` network (`connect_to_docker_network: true`) to reach the
    control plane and the projects' `supabase-db-<uuid>` hosts.

**Not verified.** Nothing ran on a server. The M6 verify (click "New project", enter a name, see the
building screen and then the project home; the project is in the dropdown and its Table Editor
works) needs a Studio image built with `multi_project: true`, the platform stack with the control
plane (M4/M5) and wildcard DNS for `<ref>.<suffix>`.

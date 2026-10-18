# Multi-project self-hosted Studio: design spec

Status: draft, 2026-10-12. Branch `platform/control-plane`. Installed by Coolify buttons (§17). M0 done (§8); M1 code done (§9); M2 and the M3 Studio side code done, server checks pending (§11); M6 Studio side code done, server check pending (§12).

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

**Build fix (2026-10-12).** The first `multi_project: true` image build (Actions run 38187495648)
failed in `next build`: Turbopack could not write `/project/[ref]/settings/integrations` because
`node:async_hooks` reached a browser chunk. Chain: page → `IntegrationSettings` → `VercelSection`
→ `lib/integration-utils.ts` → `lib/api/apiWrapper.ts` (for `isResponseOk`) →
`lib/api/self-hosted/project-context.ts` (M1 made `apiWrapper` wrap every route in the project
context). tsc, ESLint and vitest never saw it. Fix: `isResponseOk` moved to
`lib/api/apiWrapper.browser.ts` (the repo's `snippets.browser.ts` split), imported by
`apiWrapper.ts` and `integration-utils.ts`. Guard: `lib/api/self-hosted/client-import-guard.test.ts`
walks the value imports from `pages` (non-api), `components`, `hooks`, `data`, `state` and
`lib/constants`, and fails, with the chain, on any Node builtin or on `lib/api/self-hosted/**`,
`self-hosted-admin.ts`, `apiWrapper.ts` or `apiHelpers.ts`.

> Sections 13-14 were written on branch `platform/cp-service` (control plane) in parallel with
> 9-12 (Studio) and renumbered when the branches were merged.

## 13. M4 status (2026-10-12, branch `platform/cp-service`)

**What exists.**

- `deploy/platform/project-compose.yaml`: the per-project stack, `supabase-db`, `supabase-auth`,
  `supabase-rest` and `supabase-storage`, with the same images and settings as
  `deploy/coolify/docker-compose.yaml`. The db gets the project-level init SQL as content mounts
  (`webhooks.sql`, `roles.sql`, `jwt.sql`, copied from `docker/volumes/db/`, and a unit test
  keeps the copies identical). The platform-level ones (`_supabase`, `realtime`, `pooler`,
  `logs`) belong to the shared stack and are left out. No ports are published.
  - `{{REF}}`, `{{PUBLIC_URL}}` and the storage target are rendered into the text before
    upload.
  - The secrets are Coolify env vars (`${PROJECT_DB_PASSWORD}`, `${PROJECT_JWT_SECRET}`,
    `${PROJECT_ANON_KEY}`, `${PROJECT_SERVICE_KEY}`, `${S3_ACCESS_KEY}`, `${S3_SECRET_KEY}`), so
    they never appear in the compose Coolify stores.
- `apps/control-plane`: a Node 24 service in TypeScript that Node runs directly (type
  stripping), with no framework (`node:http`) and one runtime dependency (`pg`).
  - `src/secrets.ts`: the ref (20 lowercase letters), passwords, HS256 anon and service_role keys
    (`iss: supabase`, `ref`, 10-year expiry), and AES-256-GCM with ref and column as associated
    data.
  - `src/registry.ts`: schema `_platform`, tables `projects` and `project_secrets` (every secret
    column is ciphertext). The migration runs on start, is idempotent, and holds an advisory lock.
  - `src/coolify.ts`: the seven Coolify calls the provisioner makes.
  - `src/provisioner.ts`: the state machine.
  - `src/server.ts`: the HTTP API.
  - `Dockerfile`: build it from the repo root.

**Provisioning steps.** Each step checks what already exists, so running it again finishes a
run that stopped part-way:

1. Status `CREATING`.
2. Find the Coolify service named `<ref>` in the configured environment, or create it
   (`POST /services`, `instant_deploy: false`). The uuid is saved.
3. `PATCH connect_to_docker_network: true`.
4. `PATCH /services/{uuid}/envs/bulk`. This upserts, so keys Coolify made while parsing are
   overwritten.
5. Status `COMING_UP`. `POST /start`, unless Coolify already reports `running|starting`.
6. Poll `GET /services/{uuid}` every 5 s until `status == running:healthy`. The timeout is
   `PROVISION_TIMEOUT_SECONDS`, default 600.
7. Status `ACTIVE_HEALTHY`. Any error gives `FAILED` with `last_error`.

On start, the service resumes every `CREATING` or `COMING_UP` row. `FAILED` waits for an
explicit retry.

Looking the service up by name is what stops duplicates: if the process dies after Coolify
created the service but before the uuid was saved, the next run adopts that service instead of
creating another.

Delete sends `DELETE /services/{uuid}?delete_configurations&delete_volumes&docker_cleanup&delete_connected_networks`
(all `true`) for the saved uuid and for any service found by name, then deletes the registry
rows. Coolify answers 404 for the service at once and removes the containers about 7-40 s later.

**HTTP API.** Every route needs `Authorization: Bearer $CONTROL_PLANE_TOKEN`, except `/health`.

| Route | Result |
|---|---|
| `POST /projects {name}` | 201, the project in `CREATING`; provisioning continues in the background |
| `POST /projects {ref}` | 202; re-runs provisioning of an existing project |
| `GET /projects`, `GET /projects/:ref` | No secrets. Includes `endpoint` (`https://<ref>.<suffix>`) and the internal hosts `supabase-{db,auth,rest,storage}-<uuid>` |
| `GET /projects/:ref/secrets` | `db_password`, `jwt_secret`, `anon_key`, `service_key`, for Studio's resolver (M1) |
| `DELETE /projects/:ref` | 200; 409 while a provisioning run is in flight |
| `GET /health` | 200 when the registry answers |

**Config (env).**

- Required:
  - Coolify: `COOLIFY_URL` (including `/api/v1`), `COOLIFY_TOKEN`, `COOLIFY_PROJECT_UUID`,
    `COOLIFY_ENVIRONMENT`, `COOLIFY_SERVER_UUID`.
  - `REGISTRY_DATABASE_URL`.
  - `PLATFORM_SECRETS_KEY`: 32 bytes, as hex or base64, for example `openssl rand -base64 32`.
  - `CONTROL_PLANE_TOKEN`, `PROJECT_DOMAIN_SUFFIX`.
- Storage: `PROJECT_STORAGE_BACKEND` is `s3` (the default and the target) or `file`.
  - With `s3`, `PROJECT_S3_ENDPOINT`, `PROJECT_S3_ACCESS_KEY` and `PROJECT_S3_SECRET_KEY` are
    required, and `PROJECT_S3_REGION` defaults to `us-east-1`. The bucket is the ref.
  - `file` keeps objects in the project's `storage-data` volume. It is for testing only, until
    MinIO is shared.
- Optional: `PORT` (default 8080), `PROVISION_TIMEOUT_SECONDS`, `PROJECT_TEMPLATE_PATH`.

**How to run.**

```bash
cd apps/control-plane
NODE_ENV=development npm ci          # the shell may export NODE_ENV=production, which skips dev deps
npm test                             # unit tests; registry tests also run if TEST_DATABASE_URL is set
npm run typecheck
npm run test:live                    # by hand only: real Coolify, server B, local Docker
docker build -f apps/control-plane/Dockerfile -t control-plane .   # from the repo root
```

It is a standalone npm package (its own `package-lock.json`). A one-line exclusion in
`pnpm-workspace.yaml` keeps it out of the pnpm workspace, so `pnpm-lock.yaml` and the daily
upstream merge are untouched (FORK.md, "Updating from upstream").

**Test results.**

- **Unit tests: 37 pass** (vitest 5): 10 secrets, 6 template, 11 provisioner state machine with
  an in-memory Coolify, 4 HTTP, and 3 registry against a throwaway Postgres 17. Without
  `TEST_DATABASE_URL` it is 34 passed and 3 skipped. `tsc --noEmit` is clean.
- **Live: 3 of 3 pass.** Run with `test/provision.live.test.ts` against Coolify 4.4.6 and
  server B, in the temporary Coolify project "Tests", environment "control-plane". The registry
  was a local Docker Postgres. Second run, timings:

  | Scenario | Result |
  |---|---|
  | HTTP create to `ACTIVE_HEALTHY` | **18 s** (CREATING → COMING_UP → ACTIVE_HEALTHY). Coolify calls took about 1.3 s; the rest was containers starting and the health poll. All four images were already cached on B. |
  | Checks from the `coolify` network on B (`docker run --network coolify curlimages/curl`) | PostgREST `/` with the project anon key: 200. With a key signed by another secret: 401. GoTrue `/health`: 200. storage `/bucket` with the service key: 200. |
  | Server SIGKILLed right after the Coolify service was created | Registry `CREATING`, Coolify `exited`. On restart it resumed on its own (plus `POST {ref}`) and reached `ACTIVE_HEALTHY` in **12 s** with the same uuid. 1 Coolify service named ref. |
  | Coolify created the service, but the uuid was never saved (fault injected in the client) | `FAILED`, uuid `null`. The re-run found the service by name and reached `ACTIVE_HEALTHY` in **12 s**. Still 1 service. |
  | Delete | Coolify `GET` gives 404 at once. On B, the 4 containers, 5 volumes and 1 network were gone 7-39 s later. |

  After the run, the "Tests" project was deleted. B has no containers, volumes, networks or
  `/data/coolify/services/<uuid>` directories from the test, and the local registry container
  is removed.

**Deviations from §4.**

- `coolify_service_uuid` lives in `projects`, not `project_secrets`. It is not a secret, and
  `GET /projects/:ref` needs it.
- `instant_deploy` is `false`, not `true`. The env vars must be set before the first start;
  otherwise the stack would first boot without its secrets.
- Image transformations are off in project storage (`ENABLE_IMAGE_TRANSFORMATION=false`) until
  the shared imgproxy exists.
- S3 is the target, but the live test used the `file` backend, because no shared MinIO exists
  yet. The S3 path is covered only by the template tests.
- GoTrue's `--config-dir /etc/gotrue` and storage's `/etc/studio-config` are per-service named
  volumes for now. M3 swaps them for the `/data/pieowl/projects/<ref>/…` binds.
- Runs are serialised per ref inside one process, so run exactly one control-plane instance.

**What M5 needs (not part of M4).**

- Register the tenant in the shared stack after `ACTIVE_HEALTHY`:
  - Supavisor `PUT /api/tenants/<ref>`;
  - Realtime `POST /api/tenants`;
  - the Kong declarative entry (routes by `hosts: [<ref>.<suffix>]`, `key-auth` consumers for
    the anon and service keys, an `acl` group per ref), with `kong config parse` before every
    `kong reload`.

  The bodies are in `spike/register.sh` and `spike/kong-test.sh`. Make each one a further
  idempotent step after `ACTIVE_HEALTHY`, or a new status such as `REGISTERING`, and undo them
  in delete.
- Create a MinIO bucket `<ref>` and a scoped key. Then set `PROJECT_STORAGE_BACKEND=s3` and
  point `PROJECT_S3_*` at the shared MinIO.
- Set `IMGPROXY_URL` to the shared imgproxy and turn transformations back on.
- Deploy the control plane itself as a Coolify service. It needs `connect_to_docker_network`,
  the registry in the shared `_supabase` database, and an admin JWT secret for the Supavisor and
  Realtime calls.
- Cap the number of projects per server (§6 risk 7). B had about 3.2 GB available. The memory
  one project stack uses was not measured.

## 14. M5 status (2026-10-12, branch `platform/cp-service`)

Numbered 12 because `platform/control-plane` already has §10 (decisions) and §11 (M2/M3).

**Architecture as deployed (staging).**

```
internet ─ *.<platform-domain> (DNS → server A)
  └─ Traefik on A (coolify-proxy), file /data/coolify/proxy/dynamic/supa-platform-staging.yaml
       HostRegexp(`^[a-z0-9-]+\.<platform-domain>$`), TLS letsencrypt (HTTP-01, one cert per host)
       └─ http://<platform-server-ip>:8010 (WireGuard) ─ server B
            Coolify service "platform" (deploy/platform/platform-compose.yaml), on `coolify` network
              kong (3.9.1, DB-less)   proxy 8000 → published <platform-server-ip>:8010; admin 8001 unpublished
              supavisor, realtime, postgres-meta, imgproxy, minio, platform-db (postgres:17-alpine)
              control-plane          8080 → published <platform-server-ip>:8011 (for A's /hosts poll)
            Coolify services "<ref>" (project-compose.yaml), environment "projects", on `coolify`
              supabase-db / -auth / -rest / -storage  (reached as <service>-<project-uuid>)
```

- **Kong** routes per project host `<ref>.<platform-domain>`, following
  `docker/volumes/api/kong.yml`: auth (open: verify, callback, authorize, jwks, SAML acs and
  metadata, `/.well-known/oauth-authorization-server`; keyed: `/auth/v1/`), `/rest/v1/`,
  `/graphql/v1`, `/realtime/v1/` (websocket, `preserve_host` so Realtime picks the tenant from
  the host), `/realtime/v1/api` (keyed; `api/openapi` and `api/tenants` blocked with 403) and
  `/storage/v1/` (no key-auth, as in the fork; storage checks the JWT). Two `key-auth`
  consumers per project (`<ref>-anon`, `<ref>-service_role`) in ACL groups `<ref>-anon` and
  `<ref>-admin`; keyed routes allow only those two groups. No `/pg/` route (Studio talks to
  pg-meta inside the network) and no dashboard route (Studio comes after M2).
- **Kong config ownership** (`apps/control-plane/src/kong.ts`). The control plane renders the
  whole declarative config from the registry on every change (every project that has a Coolify
  service and is not `DELETING`), refuses to render values that do not look right (ref,
  uuid, JWT shape), and applies it with `POST /config`. Kong validates the whole config and
  swaps it atomically, or answers 400 and keeps serving the old one (checked on B: an invalid
  service gave 400 and the hash did not change). Applies are serialised. The last accepted
  config and Kong's hash of it are kept in memory; every 15 s the control plane compares
  Kong's `configuration_hash` (`GET /status`) and re-applies on any difference. If the
  registry cannot be rendered then, it re-applies the last good config.
  - A plain `docker restart` keeps Kong's config (DB-less Kong keeps it in LMDB inside the
    container). A recreate (any Coolify redeploy or restart) starts Kong empty; the control
    plane restores it (measured below).
- **Kong admin API guard.** The admin API listens on the container networks only, but the
  `coolify` network is shared with every Coolify service on B (the production projects included).
  So it answers only requests with the header `x-admin-token: $KONG_ADMIN_TOKEN`: the Kong
  entrypoint writes an nginx `if` into the admin server block (`KONG_NGINX_ADMIN_INCLUDE`).
  From the `coolify` network without the header: 401.
- **Supavisor and Realtime** (`src/tenants.ts`): tenant `<ref>`, db host
  `supabase-db-<project-uuid>`, the M0 bodies (`spike/register.sh`). Supavisor `PUT` upserts;
  Realtime is `GET`, then `POST` when missing. Teardown is `DELETE` (404 counts as done). Admin
  tokens are HS256, 5 min, signed with `PLATFORM_ADMIN_JWT_SECRET` (both services' `API_JWT_SECRET`).
- **MinIO** (`src/minio.ts`): bucket `<ref>` plus a **scoped service account**: access key
  (20 chars) and secret (40) are generated with the project and stored encrypted in
  `project_secrets` (`s3_access_key`, `s3_secret_key`); the account's policy allows `s3:*` on
  `arn:aws:s3:::<ref>` and `<ref>/*` only. MinIO's admin API encrypts its payloads (madmin), so
  the control plane image bundles `mc` (copied from the same MinIO image the fork uses) and
  drives it with `MC_HOST_platform`; stdout (which echoes the secret) is never logged. Teardown
  removes the account and `rb --force`s the bucket. Project stacks always use S3 now; the
  `file` backend and `storage-data` volume are gone from `project-compose.yaml`.
- **imgproxy** is shared; project storage gets `ENABLE_IMAGE_TRANSFORMATION=true` and
  `IMGPROXY_URL=http://imgproxy-<platform-uuid>:8080`. Sources are presigned MinIO URLs, so
  imgproxy has no local filesystem access (the fork sets `IMGPROXY_LOCAL_FILESYSTEM_ROOT=/`).
- **postgres-meta** is shared; its default connection points at `127.0.0.1:1`, so only requests
  with Studio's `x-connection-encrypted` header (key `PG_META_CRYPTO_KEY`) reach a database.
- **Provisioning steps** (`src/provisioner.ts`). The registry has a new `step` column (the step
  that ran last; with `FAILED`, the one that failed) and a new status `DELETING`.
  - `CREATING`: `coolify_service`, `network`, `storage`, `envs`.
  - `COMING_UP`: `start`, `health`, `pooler`, `realtime`, `gateway`.
  - Then `ACTIVE_HEALTHY` with `step = null`. Any error gives `FAILED`, `step` and
    `last_error`; `POST /projects {ref}` re-runs every step, each of which checks what exists.
  - Delete: status `DELETING`, then `gateway` (the project leaves the Kong config first, so
    traffic stops), `realtime`, `pooler`, `coolify_service`, `storage`, then the registry rows.
    A failure leaves `DELETING` with `step` and `last_error`; `DELETE` again continues.
    `provision()` does nothing for a `DELETING` project.
- **New HTTP route**: `GET /hosts` (no token): the public hostnames of the projects Kong routes,
  one per line. Server A polls it for certificates (below).

**Deviations from the M5 brief.**

1. **TLS: `HostRegexp` alone gets no certificate.** Traefik's ACME resolver only requests
   certificates for `Host()`/`HostSNI()` matchers or `tls.domains`, and a wildcard needs a DNS
   challenge (Traefik docs, "Domain Definition"); A's resolver is HTTP-01 only. So the router
   matches with the requested `HostRegexp` and lists each project host in `tls.domains`. The
   list comes from a systemd timer on A (`supa-platform-staging-sync.timer`, every 15 s) that
   reads `http://<platform-server-ip>:8011/hosts`, keeps only `^[a-z]{20}\.<platform-domain>$` names, and
   renders the file itself (files: `deploy/platform/gateway/`). If `/hosts` is unreachable the
   file stays. New hosts had a valid certificate 0-5 s after `ACTIVE_HEALTHY`. Each project
   uses one Let's Encrypt certificate (limit: 50 per registered domain per week).
2. **The image could not be built by GitHub Actions.** `.github/workflows/control-plane-publish.yml`
   exists on this branch (dispatch only; tags `<branch>`, `sha-<full sha>`, `latest` only on
   `main`), but `gh workflow run` answers `HTTP 404: workflow control-plane-publish.yml not found
   on the default branch`: GitHub only dispatches workflows that exist on the default branch, and
   `main` is off-limits here. So the image was built on B from a `git archive` tarball of
   `71df7905` (`docker build -f apps/control-plane/Dockerfile -t
   ghcr.io/krowli/supabase-control-plane:sha-71df7905279762b39c9ba991a674a387e8255db4 .`), and
   the compose uses `pull_policy: missing`. Package visibility was not touched (the package does
   not exist yet). When the workflow reaches `main`, dispatch it with
   `--ref platform/cp-service`; the repo is public, so GHCR should inherit public visibility
   **[assumption: check with an anonymous `docker manifest inspect` on B]**.
3. **No MinIO bootstrap container.** The control plane creates buckets and keys per project.
4. **`/rest/v1/` (OpenAPI root) accepts the anon key**, as in M0 and as the brief's check expects.
   Upstream's `kong.yml` restricts the root to the service key (expression route). If that matters,
   add the same restriction in `renderKongConfig` and change the check.
5. **Project stacks live in a second environment** (`projects`) of the same Coolify project, so the
   platform service and project services are not mixed.
6. **The M4 live test (`test/provision.live.test.ts`) was removed.** It ran the control plane
   without shared services, which M5 makes required; `deploy/platform/verify.py` replaces it and
   covers the full path against the deployed stack. Crash-resume stays covered by the unit tests.
7. **Coolify passes every service env var to every container of the stack** (an `.env` file for
   all services; seen with `docker inspect`), so Kong, MinIO and imgproxy also hold
   `CP_COOLIFY_TOKEN`, `MINIO_ROOT_PASSWORD` and the rest. The fork's Supabase stack has the same
   property. The Coolify-related variables are prefixed `CP_` because Coolify sets its own
   `COOLIFY_*` names in the same environment.

**Staging deployment.**

| What | Value |
|---|---|
| Coolify project "Platform (staging)" | `ipffkzbu5u5y7qjtxtbbxi58` |
| Environment of the platform stack | `staging` (`uisxxkoyuhokuz2c2ertumf2`) |
| Environment for project stacks | `projects` (`q1hlthspouol7bscyvybe1wd`) |
| Platform service "platform" | `<uuid>`, server db-b `l6kmhkc8cr107te5xkqs9ese`, `connect_to_docker_network: true` |
| Control-plane image | `ghcr.io/krowli/supabase-control-plane:sha-71df7905279762b39c9ba991a674a387e8255db4` (built on B) |
| Public gateway | `https://<ref>.<platform-domain>` → A Traefik → `<platform-server-ip>:8010` |
| Control plane (internal) | `http://control-plane-<uuid>:8080` on `coolify`; `<platform-server-ip>:8011` on WireGuard |
| Secrets file | `/tmp/platform-staging.env` on the operator's Mac, mode 600 (generated by `deploy.py secrets`) |

The secrets file is the only copy outside Coolify. `/tmp` does not survive a reboot of the Mac:
move it somewhere durable (or read the values back from Coolify's env UI) before relying on it.

Env names of the platform service (values in the secrets file and Coolify):
`PLATFORM_DB_PASSWORD`, `PLATFORM_ADMIN_JWT_SECRET`, `SUPAVISOR_SECRET_KEY_BASE`,
`SUPAVISOR_VAULT_ENC_KEY`, `REALTIME_SECRET_KEY_BASE`, `REALTIME_DB_ENC_KEY`, `PG_META_CRYPTO_KEY`,
`MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `KONG_ADMIN_TOKEN`, `CONTROL_PLANE_TOKEN`,
`PLATFORM_SECRETS_KEY`, `CP_COOLIFY_URL`, `CP_COOLIFY_TOKEN` (the operator's Coolify token, from
`~/.coolify-token`), `CP_COOLIFY_PROJECT_UUID`, `CP_COOLIFY_ENVIRONMENT` (`projects`),
`CP_COOLIFY_SERVER_UUID`, `PROJECT_DOMAIN_SUFFIX` (`<platform-domain>`), `PROJECT_S3_ENDPOINT`
(`http://minio-<platform-uuid>:9000`), `PROJECT_IMGPROXY_URL` (`http://imgproxy-<platform-uuid>:8080`).
Control-plane env added in M5: `KONG_ADMIN_URL`, `KONG_ADMIN_TOKEN`, `SUPAVISOR_URL`,
`REALTIME_URL`, `PLATFORM_ADMIN_JWT_SECRET`, `MINIO_URL`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`,
`PROJECT_S3_ENDPOINT`, `PROJECT_IMGPROXY_URL` (the compose sets the URLs to the stack's short
names). Removed: `PROJECT_STORAGE_BACKEND`, `PROJECT_S3_ACCESS_KEY`, `PROJECT_S3_SECRET_KEY`.

**How to redeploy.** Superseded: the platform is a Coolify application now, installed and
updated with Coolify's buttons, and `deploy.py` and the gateway timer are gone (§17).

**Test results.**

- **Unit tests: 51 pass** (vitest 5), with the registry tests against a throwaway Postgres 17
  on B through an SSH tunnel; `tsc --noEmit` clean. New: Kong rendering (host scoping, per-project
  ACLs, consumers, Realtime host preservation, injection guards) and `KongGateway` against an
  in-memory admin API (rejected config keeps the old one; reconcile restores after an empty
  restart, from the registry or from the last good config); provisioner steps for every shared
  service failing once and a re-run finishing; delete undoing everything, and a failed delete
  staying `DELETING` and finishing on the next call; `/hosts`; MinIO key limits.
- **Live (`verify.py`, third run, 2026-10-11 23:55 UTC): 29 of 29 pass.** Earlier runs: the first
  failed only because Coolify removed the service directory after the check ran (the check now
  waits); the second used `docker compose --force-recreate kong` outside Coolify, which leaves
  Kong off the `coolify` network (Coolify attaches it itself), so the check now restarts the
  service through the Coolify API.

  | Check | Result |
  |---|---|
  | `POST /projects` → `ACTIVE_HEALTHY` (all steps, images cached) | 201, **20-21 s** |
  | TLS certificate for `<ref>.<platform-domain>` | valid 0-5 s after `ACTIVE_HEALTHY` |
  | `/rest/v1/` anon key / foreign key / no key | 200 / 401 / 401 |
  | `/auth/v1/health` | 200 |
  | Storage: create bucket, upload, download (service key) | 200, 200, bytes match |
  | Storage image transform (`/render/image/authenticated/…?width=16`) | 200 (shared imgproxy) |
  | Object in MinIO bucket `<ref>` | `<ref>/m5/hello.txt/<version>` present |
  | Project S3 key: own bucket / another bucket | allowed / denied |
  | `psql` via Supavisor `supavisor-<uuid>:6543` as `postgres.<ref>` | reaches the project db (its `authenticator` and `supabase_admin` roles) |
  | `wss://<ref>…/realtime/v1/websocket?apikey=<anon>&vsn=1.0.0` / foreign key | 101 / 401 |
  | Coolify restart of the whole platform stack | routes back after **13 s**; the new control plane logged `kong.drift` and re-applied |
  | Delete | 200; registry 404; Supavisor and Realtime tenants 404; Kong 0 services; `/hosts` empty; public URL 404; bucket and service account gone; containers gone after ~20 s; no volumes, networks or service directory |

**RAM** (`docker stats`, steady state, idle, MB):

| Platform stack | | Project stack | |
|---|---|---|---|
| kong | 112-125 | supabase-storage | 220 |
| realtime | 180-189 | supabase-db | 88-89 |
| supavisor | 168-171 | supabase-rest | 22-28 |
| minio | 79-210 | supabase-auth | 9 |
| postgres-meta | 108-144 | | |
| platform-db | 41-51 | | |
| control-plane | 36-42 | | |
| imgproxy | 15-17 | | |
| **total** | **~800-890** | **total** | **~260-350** |

B had 2.85 GB available before the platform stack and 2.3-2.4 GB with it running (read before
and after each verify run). So, at idle, B fits about 5 projects at ~350 MB each before the
500 MB floor; real load and Postgres caches will cut that.
storage-api is the largest per-project cost.

**State at the end.** The platform stack is running (`running:healthy`), with no projects: the
registry is empty, MinIO has no buckets or service accounts, the `projects` environment has no
services, and the Traefik file lists no domains. Kong answers 404 for any `*.<platform-domain>`.
Test-only leftovers removed: the throwaway Kong and Postgres containers and one anonymous volume.

**What M6 needs.**

- Get `control-plane-publish.yml` onto `main` (or decide to keep building on B) and switch the
  platform compose to a pulled image; confirm anonymous pull of the GHCR package from B.
- Studio in the platform stack (after M2): `STUDIO_PROJECT_REGISTRY_URL=http://control-plane:8080`
  and `STUDIO_PROJECT_REGISTRY_TOKEN=$CONTROL_PLANE_TOKEN`, pg-meta at `http://postgres-meta:8080`
  with `PG_META_CRYPTO_KEY` (already in the stack env), `PLATFORM_ADMIN_JWT_SECRET` for the
  Supavisor/Realtime admin calls, and a Kong (or Traefik) route for the dashboard with basic auth.
  The registry reader on `platform/control-plane` maps unknown statuses to `UNKNOWN`; map
  `DELETING` (new here) explicitly, and `step`/`last_error` can drive BuildingState's message.
- Studio's local `POST /platform/projects` → control plane `POST /projects`; poll
  `GET /projects/<ref>` until `ACTIVE_HEALTHY` (about 20 s with cached images).
- A dedicated Coolify API token for the control plane (it now uses the operator's token, which
  can touch every project, the production projects included), and a cap on projects per server (§6
  risk 7; see RAM above).
- Production gateway TLS: per-host HTTP-01 is fine for a handful of projects; for many, a DNS-01
  wildcard for `*.<platform-domain>` (needs a DNS provider API token in A's Traefik) would remove
  the per-project certificate and the `/hosts` poll.
- Move the secrets file out of `/tmp`.

## 15. M7 integration status (2026-10-12): Studio in the staging platform stack

**What is deployed** (Coolify project "Platform (staging)", service `<uuid>` on
server B; commits `71399f9a..` on `platform/control-plane`).

| Container | Image |
|---|---|
| `studio` (new) | `ghcr.io/krowli/supabase-full-access-studio:platform-control-plane@sha256:c7d769be3ced293cb633451ed06625531d6956f1c9ed7f65f2bd9f936db7ad32` (commit `ca0ecb9b`, `NEXT_PUBLIC_IS_MULTI_PROJECT=true`; `latest` untouched) |
| `control-plane` | `ghcr.io/krowli/supabase-control-plane:sha-71399f9a9c1f352e10557568040c293a5fde3e34` (built on B as in §14) |
| the rest | unchanged from §14 |

- **URL:** `https://studio.<platform-domain>`. Kong (the platform's, `<platform-server-ip>:8010`) routes the host
  to `http://studio:3000` behind `basic-auth`; the control plane renders that route
  (`apps/control-plane/src/kong.ts`, `renderDashboard`) when `DASHBOARD_URL` is set. The basic-auth
  consumer is in no ACL group, so its credentials open no project route, and no project key opens
  the dashboard. The service's read timeout is 180 s (a project delete waits for every step).
- **Coolify Links (M8):** the service's Links dropdown shows `https://studio.<platform-domain>`
  (deploy.py sets it as Kong's URL) and, unavoidably, two bogus entries
  `https://<coolify-host>:<platform-server-ip>`: Coolify 4.4.6 adds one link per `ports:` entry
  (`app/View/Components/Services/Links.php`, base URL + the part before the first `:`), and has
  no setting to hide them; dropping the two `<platform-server-ip>:` bindings would break A's route and the
  `/hosts` poll. See §16.
- **Log in:** the browser asks for basic auth (since M8 the keys are `SERVICE_USER_ADMIN` /
  `SERVICE_PASSWORD_ADMIN`, §16). Before M8: user and password are `DASHBOARD_USERNAME` and
  `DASHBOARD_PASSWORD` in the SOPS file `infra/platform/staging.env` (`sops decrypt
  platform/staging.env`). They were rotated once during M7 (the first pair was printed to an
  operator log by mistake). After basic auth Studio has no login of its own.
- **TLS:** `/hosts` lists `studio.<suffix>` first; the A-side sync script now accepts the label
  `studio` (`DASHBOARD_LABEL`) besides 20-letter refs, so the dashboard host gets its own
  HTTP-01 certificate the same way projects do. The installed script on A and its copy in
  `infra/servers/a/` match `deploy/platform/gateway/supa-platform-sync.sh`.
- **Studio env** (`platform-compose.yaml`): `STUDIO_PROJECT_REGISTRY_URL=http://control-plane:8080`
  (same stack, short name), `STUDIO_PROJECT_REGISTRY_TOKEN=$CONTROL_PLANE_TOKEN`,
  `STUDIO_PROJECT_DOMAIN_SUFFIX=$PROJECT_DOMAIN_SUFFIX`, `STUDIO_DEFAULT_PROJECT=none`,
  `STUDIO_PG_META_URL=http://postgres-meta:8080` + `PG_META_CRYPTO_KEY`,
  `PLATFORM_ADMIN_JWT_SECRET`, `SUPAVISOR_URL`/`REALTIME_URL` (shared services),
  `STUDIO_INTERNAL_URL=http://studio-<platform-uuid>:3000` (project GoTrue fetches email templates
  over `coolify`), `SNIPPETS_MANAGEMENT_FOLDER` (volume `studio-snippets`). The per-project config
  dir is the bind `/data/supa-platform-staging/projects` → `/data/pieowl/projects` (Studio's fixed
  `projectsDir`; the host path avoids anything named after project A).
- **deploy.py** now also takes `--studio-image <image>@sha256:<digest>` (refuses an unpinned
  image), generates `DASHBOARD_USERNAME`/`DASHBOARD_PASSWORD` with `secrets`, and sets
  `STUDIO_INTERNAL_URL`. Redeploy:

  ```bash
  sops decrypt infra/platform/staging.env > /tmp/plt/staging.env   # mode 600
  deploy/platform/deploy.py deploy /tmp/plt/staging.env --project ipffkzbu5u5y7qjtxtbbxi58 \
    --environment staging --server l6kmhkc8cr107te5xkqs9ese --service <uuid> \
    --tag sha-71399f9a9c1f352e10557568040c293a5fde3e34 \
    --studio-image ghcr.io/krowli/supabase-full-access-studio:platform-control-plane@sha256:c7d769be3ced293cb633451ed06625531d6956f1c9ed7f65f2bd9f936db7ad32
  deploy/platform/verify.py /tmp/plt/staging.env --platform <uuid>
  ```

**`default` on a platform with no single-project stack.** Chosen: `STUDIO_DEFAULT_PROJECT=none`
makes `default` a stackless entry that lands on the project list.

- Server (`project-context.ts`, `project-list.ts`, `multi-project.ts`): `default` reads nothing from
  the container environment, so every backend read for it throws ("Project default has no stack
  here …") instead of reaching whatever `POSTGRES_HOST`/`db` resolves to; it is left out of every
  project list (switcher, org page, profile); its detail still answers, with status `REMOVED` and
  no endpoint.
- Client (`ProjectLayout` `ContentWrapper`, 7 lines; `ProvisioningState.tsx`): `default` with
  `REMOVED` is `router.replace('/org/default-org-slug')`, upstream's project list of the one
  organization (search, status filter, cards, "New project"). `REMOVED` because no layout draws a
  screen for it; `INACTIVE` would have been upstream's "paused" screen on every page but home.
- Why this one: `/`, the sign-in redirect, the home icon, the 404 fallback and the delete dialog
  all go to `/project/default` (7 upstream places plus `redirects.shared.ts`, which is build time),
  so `default` has to exist; pointing it at the platform's own Postgres would have put the
  registry, the Supavisor and Realtime metadata one SQL Editor query away from a typo; hiding it
  everywhere would have meant patching every one of those places. Without the variable nothing
  changes (single-project and production-style stacks keep `default` as before).

**DELETING (M5 status).** `control-plane-registry.ts` maps `DELETING` → `GOING_DOWN` and does not
ask for the secrets of a project being deleted (they go with its rows; asking could fail the whole
registry read). `ProvisioningState` shows "<name> is being deleted" with **Delete again** (the
control plane's next `DELETE` continues from the failed step) on every database page.

**Tests.** Studio (`NODE_ENV=test vitest --run`, whole suite, after `ca0ecb9b`): **741 files,
8632 passed, 0 failed** = the 8618 baseline + 14 new (`project-context` +2, `control-plane-registry`
+2, `project-switcher` +3, `ProvisioningState` +2, `ProjectLayout/index.multi-project` +5). An
earlier run while the operator's Mac was sleeping had one 5 s timeout in an untouched upstream
test (`SchemaSelector.test.tsx`); the clean run above passes it. `tsc --noEmit` clean; ESLint on touched files 0 errors. Control plane:
52 tests (49 passed, 3 registry tests skipped without `TEST_DATABASE_URL`), +1 (dashboard route) and
`/hosts` extended; `tsc` clean.

**verify.py** (3 new checks: dashboard 401 without credentials, 200 with, `/hosts` lists the
dashboard): **32 of 32 pass** (log kept as `/tmp/plt/verify-m7.log` on the operator Mac). Create →
`ACTIVE_HEALTHY` 23 s, certificate at once, Coolify restart of the whole stack → routes back in
13 s, delete leaves nothing. RAM: platform stack 1058 MB with Studio (was ~850-890), one project
337 MB; B had 2.1-2.2 GB available.

**End to end in a real browser** (Playwright 1.64 + Chrome for Testing, headless, basic auth via
`httpCredentials`; scripts in `/tmp/plt/scripts/`, screenshots and logs in `/tmp/plt/e2e/`):

| Step | Result |
|---|---|
| `https://studio.<platform-domain>/` | lands on `/org/default-org-slug`, "Create a project" empty state (`01-one-landing.png`) |
| New project "e2e-one" (org page) → building screen → home | submit 0.2 s, building screen shown, **home after 21.8 s** (`01-one-*`) |
| SQL Editor: create table + insert (Studio asks about RLS → "Run and enable RLS") | 7.1 s (`02-one-sql.png`) |
| Table Editor shows the table and its row | 3.7 s (`02-one-table-editor.png`) |
| Auth → Users loads | 3.4 s (`02-one-auth-users.png`) |
| Storage → create bucket | 6.5 s (`02-one-storage.png`) |
| API keys (legacy tab shows the project's anon/service keys), Data API URL, Connect sheet | own host `https://<ref>.<platform-domain>`, no `localhost` (`02-one-api-keys*.png`, `02-one-data-api.png`, `02-one-connect.png`) |
| New project "e2e-two" from the header dropdown | home after 21.8 s (`03-two-*`); same pages pass (`04-two-*`) |
| Switch in the dropdown | 4.0 s; e2e-one shows only `e2e_t_one`, e2e-two only `e2e_t_two`, and back (`05-switch-*`); "Default Project" is no longer listed |
| Delete both via Settings → General → Delete project | 7.9 s each in the UI, lands on the project list (`06-two-*`, `07-one-*`) |
| Afterwards | control plane 0 projects; `/hosts` = `studio.<platform-domain>` only; Coolify `GET /services/<uuid>` 404 and the `projects` environment empty; on B 0 containers, volumes, networks and service dirs for both uuids; MinIO 0 buckets, 0 service accounts; public REST for the old ref 404 (`run-08-gone.log`) |

Console/HTTP errors seen: while a project is `COMING_UP` the header and Connect queries
(`databases`, `settings`, `api-keys`, two `pg-meta` queries) answer 500 "Project <ref> is not ready
(COMING_UP)" and are retried until it is up (3-5 times each); the two same queries for `default`
fire once before the redirect to the project list (500 "no stack here"); after a delete the open
tab re-reads the deleted project once or twice (404) before it moves; `run-lints` for `default`
answers 400 (upstream, single-project too). One `[pageerror] Object` from the SQL editor (Monaco)
on one run. None blocks a step.

**Open issues.**

- **(Fixed in M8, §16.) Project auth/storage settings do not reach the projects yet.** Studio writes
  `<projectsDir>/<ref>/{gotrue,storage}` (now `/data/supa-platform-staging/projects` on B), but
  `project-compose.yaml` still mounts per-service named volumes there (§13 deviation, "M3 swaps
  them"). Bind the project stacks to the same host dir, and remove `<ref>/` on delete (the control
  plane does not today).
- (Fixed in M8, §16: 503.) Not-ready reads answer **500**; a 503 (or `ProjectContextError` → 409) would read as "not yet"
  rather than a failure in the console.
- The "being deleted" screen was not caught live (the delete finished before a second tab loaded);
  it is covered by `ProvisioningState.test.tsx` and `index.multi-project.test.tsx`.
- (Fixed in M8, §16.) The org page's sidebar keeps upstream's Team / Usage / Billing links, which do nothing self-hosted.
- Snippets are one folder for all projects; logs (no Logflare in the platform), MCP (refused, §11),
  the edge-functions test route, per-project publishable/secret keys (only legacy keys exist) remain
  as in §11-§12.
- `control-plane-publish.yml` still cannot be dispatched until it is on `main`; the image is built on B.
- The control plane still uses the operator's Coolify token (§14, "owner to do").

**How to move production projects Supabase onto the platform later (not done).**

1. Create the project through the platform (`POST /projects {name}` or Studio) so it gets a ref,
   secrets, a stack, tenants, a bucket and a Kong route; keep it unused.
2. Freeze writes on the old stack, `pg_dump` the old database (roles/`auth`/`storage` schemas
   included, `--no-owner` where roles differ) and restore into `supabase-db-<uuid>`; copy objects
   from the old storage into MinIO bucket `<ref>` (`mc mirror`).
3. Either keep the old JWT secret and keys (write them into `project_secrets` before the first
   start, so existing clients and sessions keep working) or rotate clients to the new keys.
4. Point the app at `https://<ref>.<platform-domain>` (or add a custom host to the Kong route and
   the A-side certificate list), check, then delete the old Coolify stack. Do it on staging with a
   copy first; the production projects stay untouched until then.

## 16. M8 settings status (2026-10-12): per-project auth and storage settings take effect

**What changed** (commits `76e9ac27..` on `platform/control-plane`).

- **Settings directories.** Studio's resolver writes a project's files to
  `/data/pieowl/projects/<ref>/{gotrue,storage,state}` inside its container
  (`project-context.ts` `DERIVED_ENV`). That container path is now the host directory
  `PROJECTS_HOST_DIR` (deploy.py `--projects-host-dir`, default `/data/supa-platform-staging/projects`;
  rendered into the platform compose as `{{PROJECTS_HOST_DIR}}`, no longer hard-coded).
  - `project-compose.yaml` binds `<dir>/<ref>/gotrue` → `/etc/gotrue:ro` in `supabase-auth`
    (started with `auth --config-dir /etc/gotrue`, template reloading on) and `<dir>/<ref>/storage` →
    `/etc/studio-config:ro` in `supabase-storage` (the fork's `set -a; . storage.env` command). The
    named volumes `gotrue-config` and `storage-config` are gone. The control plane renders the
    placeholder `{{PROJECTS_HOST_DIR}}` from its env `PROJECTS_HOST_DIR`.
  - The control plane owns the directories, without the Docker socket: the platform compose binds
    `<dir>` into it at the same path, and a one-shot `projects-dir` container (the control-plane
    image as root) `chown`s `<dir>` to uid 1000 before the control plane starts. A new first
    provisioning step `config_dirs` creates `<ref>/` (0750) with `gotrue`, `storage` (0755) and
    `state` (0700), owned 1000:1000 (the control plane's `node` user, also GoTrue's `supabase`
    user), before the Coolify service exists, so Docker never auto-creates them as root. Delete ends
    with `config_dirs`: `rm -rf <ref>/` (Studio's files inside are root-owned, but the directories
    are the control plane's, so it may remove them); a failure leaves `DELETING` with
    `step=config_dirs` and the next `DELETE` finishes (`src/project-dirs.ts`, tests in
    `test/project-dirs.test.ts`, `provisioner.test.ts`).
  - Templates: Studio writes `GOTRUE_MAILER_TEMPLATES_<ID>=$STUDIO_INTERNAL_URL/api/platform/auth/<ref>/templates/<id>/content`,
    `STUDIO_INTERNAL_URL=http://studio-<platform-uuid>:3000`; project GoTrue reaches it over
    `coolify` (checked by verify.py from inside the auth container).
- **Stack settings mirrored.** Studio answers a settings page before anything is saved from what
  the stack runs with, and a save renders every setting. Control-plane projects had none of the
  mirrored values, so a first save would have written GoTrue's own defaults (phone sign-in off, SMS
  autoconfirm off, Site URL `http://localhost:3000`) and storage's (50 MB, image transforms off).
  `control-plane-registry.ts` now gives each project `STACK_SETTINGS` (the compose's GoTrue,
  storage-api and PostgREST values) and `GOTRUE_SITE_URL=https://<ref>.<suffix>`; a test keeps
  `STACK_SETTINGS` equal to `project-compose.yaml`.
- **Not-ready reads → 503.** `projectEnv` throws `ProjectNotReadyError` for a project without a
  stack (COMING_UP, or GOING_DOWN); `withProjectContext` answers it `503` with `Retry-After: 5` and
  "Project <ref> is not ready yet (COMING_UP): its stack is still being set up and has no <NAME>.
  Try again in a few seconds" (being deleted: "… it is being deleted …"). `default` without a stack
  stays 500 "no stack here".
- **Org menus.** Under `NEXT_PUBLIC_IS_MULTI_PROJECT` the organization sidebar
  (`components/interfaces/Sidebar.tsx`, +6 −1) and the mobile org menu (`OrgMenuContent.tsx`,
  +5 −1) show Projects only. Team, Integrations, Usage, Billing and Organization settings read
  `/platform/organizations/<slug>/…` routes self-hosted Studio does not have (404s, endless
  skeletons; checked live before the change, `/tmp/plt/e2e-settings/00-org-*.png`).
- **Dashboard login in Coolify.** Coolify 4.4.6 fills the service page's "Service configuration"
  panel from `Service::extraFields()` (`app/Models/Service.php:343`, rendered by
  `StackForm.php:98` / `stack-form.blade.php:63`): for any container whose image contains `kong` it
  shows the service env vars `SERVICE_USER_ADMIN` / `SERVICE_PASSWORD_ADMIN` as
  "Supabase · Dashboard User / Dashboard Password" (`Service.php:709-732`, the one-click Supabase
  template's mechanism). The keys are now named so in the SOPS file and Coolify; the control plane
  still reads `DASHBOARD_USERNAME=${SERVICE_USER_ADMIN}` / `DASHBOARD_PASSWORD=${SERVICE_PASSWORD_ADMIN}`.
  The owner sees them at Projects → Platform (staging) → staging → platform → General → Service
  configuration.
- **Links.** deploy.py sets Kong's URL to `https://studio.<suffix>` (`PATCH /services/<uuid>`
  `urls`; Studio's is cleared first, Coolify refuses a domain two containers hold). Coolify then
  labels Kong for B's own Traefik (router `Host(studio.<platform-domain>)` → Kong :8000). That proxy
  is not reachable from the internet (B's 80/443 time out from outside) and the route ends at Kong's
  basic auth (401 without credentials, checked on B); its only effect is a failed ACME HTTP-01
  attempt in B's proxy log on each reload (B's own ACME account; A's certificate is unaffected).
  A Studio URL would have routed B's proxy straight to Studio without basic auth, and a user label
  `traefik.enable=false` does not override Coolify's generated one (tried). The two port-derived
  bogus links stay (§15).
- **Secrets rotated.** Every value in `infra/platform/staging.env` (14 keys) was regenerated with no
  projects on the platform, after the file had been in the operator Mac's `/tmp` while a stray
  `python -m http.server` served `/tmp` on all interfaces. `PLATFORM_DB_PASSWORD` needs
  `ALTER USER postgres` in `platform-db` before the redeploy (the volume keeps the old password).
  MinIO, Supavisor and Realtime (no tenants) took the new keys on restart. Old dashboard
  credentials → 401, new → 200. infra commit `85cee26`.

**Images.** Studio `ghcr.io/krowli/supabase-full-access-studio:platform-control-plane@sha256:a9d0db9a2b7617928345f5934ab768c2563e94d0f1d10206b307cc3e7cf16ad2`
(commit `cf0a2c79`, Actions run 38208253672, `multi_project=true`; `latest` untouched); control
plane `ghcr.io/krowli/supabase-control-plane:sha-cf0a2c79a72d89c388734e241e085e620595345b`
(built on B).

**Tests.**

| | Files | Tests | Failed |
|---|---|---|---|
| Studio before (M7, `080cfb2c`) | 741 | 8632 | 0 |
| Studio after (`cf0a2c79`) | 742 | 8636 | 0 |
| Control plane before | 6 (1 skipped) | 49 passed + 3 skipped | 0 |
| Control plane after | 7 (1 skipped) | 56 passed + 3 skipped | 0 |

By test id: no Studio test changed status; one was renamed with its new expectation
(`project-switcher` "refuses its database until its stack exists" → "answers its database reads
503 …", also covering a pg-meta query); new: `Sidebar.multi-project.test.tsx` (3),
`control-plane-registry` STACK_SETTINGS vs compose (1). `tsc --noEmit` clean (Studio and control
plane); ESLint on touched Studio files 0 errors (1 existing warning in `Sidebar.tsx`).

**verify.py** now 42 checks (+10: settings dirs and owner, binds and `--config-dir`, Studio auth
save, GoTrue applied it without restart (`/auth/v1/settings` `external.anonymous_users`, ~7 s),
"reloading api with new configuration", email template fetched from Studio over `coolify`, Studio
storage save, `storage.env` in the container, saved limit after a storage restart (2000 B → 413,
500 B → 200), image transforms still on, `<ref>/` removed on delete). Run after the rotation:
**42 of 42 pass** (`/tmp/plt/verify-m8-2.log`), create → ACTIVE_HEALTHY 20 s, Coolify restart →
routes back in 15 s. The first run (old secrets) failed only its own new check, which read
`anonymous_users` at the top level; fixed. RAM: platform 1084 MB, one project 324 MB; B 2.5 GB
available.

**Browser end to end** (Playwright + Chrome for Testing, screenshots `/tmp/plt/e2e-settings/`):

| Step | Result |
|---|---|
| New project "settings-test" | home after 21.8 s; building-time reads now 503 "not ready yet" (console) |
| Auth → URL Configuration opens on `https://<ref>.<platform-domain>` (mirrored); set `https://m8-site.example.com`, save | 200; reload shows the new value; `99_studio.env` has `GOTRUE_SITE_URL="https://m8-site.example.com"` |
| Auth → Emails → SMTP: on, host `smtp.example.com`, port 2525, dummy user/pass/sender, save | 200; reload shows them; `GOTRUE_SMTP_HOST/PORT/USER/ADMIN_EMAIL` in `99_studio.env` |
| Sign In / Providers: Allow anonymous sign-ins on, save | 200; `GET https://<ref>.<platform-domain>/auth/v1/settings` → `external.anonymous_users: true` (phone and email still true) |
| GoTrue on B | `starting configuration reloader`, then `reloading api with new configuration` (the three saves 4 s apart fell into one 5 s grace period: one reload) |
| Storage → Settings opens on 500 MB (mirrored); set 1 MB, save | 200; `storage.env` in the container has `UPLOAD_FILE_SIZE_LIMIT="1048576"` and image transforms `true`; after `docker restart supabase-storage-<uuid>` PID 1 runs with 1048576: 2 MB upload → 413 "Payload too large", 0.5 MB → 200 |
| Delete from Settings → General | 7.8 s; `<dir>/<ref>/` gone; control plane 0 projects, `/hosts` = studio only, no Coolify service, no containers/volumes/networks/service dir, MinIO 0 buckets and service accounts |
| Org page | sidebar shows Projects only (`11-org-sidebar.png`) |

**Remaining issues.**

- (Fixed in §20.) **Storage settings need a storage restart, and Studio cannot trigger it** on the platform. The
  page says to restart `supabase-storage`; today that is `docker restart supabase-storage-<uuid>`
  on B or a Coolify restart of the project service (restarts its whole stack). A control-plane
  route (e.g. `POST /projects/<ref>/restart {service: storage}`) and a button would close it.
- Site URL and SMTP are not visible in `/auth/v1/settings`; they were confirmed in `99_studio.env`,
  the reload log line and Studio's read-back, not by sending mail.
- Studio writes its files as root; the control plane can remove them only because it owns the
  directories. If Studio ever wrote a sub-directory there, delete would stop at `config_dirs`.
- (No longer true, checked live in §20.) Project settings menu still has upstream's Billing group
  (Subscription / Usage links) and the command menu's org entries; only the org sidebars were trimmed.
- `STACK_SETTINGS` duplicates values from `project-compose.yaml` (guarded by a test); a project
  stack with different values would need them per project from the control plane.
- B's Coolify proxy logs a failed ACME attempt for `studio.<platform-domain>` on each reload (above).
- Unchanged from §15: `default` reads before the redirect answer 500 "no stack here", snippets
  shared, no Logflare, MCP refused, control-plane image built on B, operator's Coolify token.

## 17. Install by Coolify buttons (2026-10-12)

The platform installs and updates with Coolify actions only; `deploy.py` and the gateway's systemd
timer are deleted. Everything below was done on the staging install and checked end to end.

**Two Coolify applications** (Docker Compose build pack, from this public repo, branch
`platform/control-plane`), both in the Coolify project "Platform (staging)", environment `staging`:

| Application | Server | Compose file | To fill in |
|---|---|---|---|
| `platform` (`<platform-app-uuid>`) | db-b | `/deploy/platform/platform-compose.yaml` | `CONTROL_PLANE_COOLIFY_TOKEN` |
| `gateway` (`<app-uuid>`) | localhost (A) | `/deploy/platform/gateway/compose.yaml` | nothing |

What replaced each `deploy.py` duty:

- **Secrets** are Coolify magic variables in the compose, generated on the first load of the
  compose file and shown under Environment Variables: `SERVICE_PASSWORD_*` (32 letters and
  digits), `SERVICE_PASSWORD_64_*`, `SERVICE_USER_*` (16), `SERVICE_HEX_64_SECRETSKEY` (64 hex,
  `PLATFORM_SECRETS_KEY`). Checked in Coolify 4.4.6 `generateEnvValue()` and
  `parseCommandFromMagicEnvVariable()` (no underscore in the name after the generator). Realtime
  needs a 16-character `DB_ENC_KEY`: its command cuts the 32-character value with `printf %.16s`.
  Dashboard login: `SERVICE_USER_STUDIO` / `SERVICE_PASSWORD_STUDIO`.
- **Plain settings** have defaults in the compose (`${VAR:-default}`), so Coolify pre-fills them:
  `PROJECT_DOMAIN_SUFFIX`, `CONTROL_PLANE_COOLIFY_URL`; on A `PLATFORM_HOSTS_URL`,
  `PLATFORM_KONG_URL`. `CONTROL_PLANE_COOLIFY_TOKEN` is `${VAR:?}`: Coolify marks it required and
  leaves it empty (a message after `?` would become the value).
- **The control-plane image** is built by Coolify on the server on every deploy (`build:` with the
  repo root as context). `control-plane-publish.yml` is no longer needed for the platform.
- **Studio** is pinned by digest in the compose; a new Studio is a commit, then Deploy.
- **Coolify target.** The control plane reads its own application uuid (`COOLIFY_RESOURCE_UUID`,
  which Coolify sets in every container of a compose application), takes the project and server
  from `GET /applications/<uuid>`, and creates the `projects` environment (`POST
  /projects/<uuid>/environments`, 409 when it exists). `src/coolify.ts` `resolveCoolifyTarget`,
  tested in `test/coolify-target.test.ts`.
- **Networking.** Compose applications name containers `<service>-<uuid>-<timestamp>` unless
  "Consistent container names" is on (Coolify `generateApplicationContainerName()`), so other
  stacks reach the platform by fixed aliases on the `coolify` network: `supa-platform-minio`,
  `-imgproxy`, `-studio` (project stacks), `-control-plane`, `-kong`, `-supavisor`, `-realtime`,
  `-postgres-meta`. The compose declares `coolify` as an external network itself, so the
  "Connect to Predefined Network" checkbox stays off; `platform-db` and `projects-dir` are not on
  it. Compose also adds each short service name as an alias there; project stacks name their
  services `supabase-*`, and project A's and project B's stacks are not on `coolify`. One platform per
  server (the aliases are fixed).
- **Projects directory** is fixed: `/data/supa-platform/projects`.
- **Gateway on A** is the `gateway` application: an `alpine` container running the old sync script
  every 15 s, with `/data/coolify/proxy/dynamic` bound in. It writes `supa-platform.yaml` (was
  `supa-platform-staging.yaml` from the timer). The script is the compose `command`, not a
  `content:` file: Coolify writes a content file on the first deploy and keeps its stored copy on
  later ones, so a changed script would never arrive. Healthy while `/hosts` answered within a
  minute.

**Not changed.** Kong and the control plane still publish `<platform-server-ip>:8010` and `<platform-server-ip>:8011`
(WireGuard only); B stays closed. No domains are set on either application, so Coolify adds no
proxy labels.

**Checks.** `verify.py --app <platform-app-uuid>` (reads the secrets from Coolify's API;
finds containers by their Compose labels): 42 of 42 pass, create to ACTIVE_HEALTHY 20 s,
certificate 10 s, recovery after a Coolify restart 86 s. Through Studio's own API with the
dashboard login: two projects created, both listed and opened, auto-confirm switched on in auth
settings, sign-up, sign-in, `/auth/v1/user` and REST as that user, then both deleted and the
`projects` environment left empty. Control plane: 61 tests pass, `tsc --noEmit` clean.


## 18. Production (2026-10-12): the production projects on the platform

- The platform runs from `main` (fork branch fast-forwarded). Coolify project "Platform" (was
  "Platform (staging)"), environment `production` (was `staging`) with the apps `platform` and
  `gateway`; project stacks in `projects`. Studio's organisation: "Platform". Sections §14–§17 keep
  the old names as history.
- Studio image: `ghcr.io/krowli/supabase-full-access-studio:platform@sha256:…`, built by a manual
  "Publish Studio (fork)" run on `main` with `multi_project` (tags `platform`,
  `platform-<date>-sha-<sha>`); `latest` stays the plain single-project build from pushes to `main`.
  Pushes that only touch `deploy/**` or `apps/control-plane/**` skip the Studio build.
- Pooler for apps outside B: Supavisor published on `<platform-server-ip>:6543` (transaction) and
  `<platform-server-ip>:6542` (session, container port 5432). Tenants use `require_user: false` with
  `auth_query` run by the manager `pgbouncer` (password = project db password), so any project role
  connects as `<role>.<ref>` (src/tenants.ts, test/tenants.test.ts). Prisma: `pgbouncer=true` on 6543,
  `directUrl` on 6542.
- Projects: `project-a` (`<ref-1>`, role `project-a` for the project A apps) and `project-b`
  (`<ref-2>`, 7 app migrations, 3 pg_cron jobs — pg_cron works in project stacks).


## 19. Backups (2026-10-12): Database → Backups

- **Service:** `backup` in `platform-compose.yaml`, the control-plane image run as
  `node src/backup/main.ts` (`apps/control-plane/src/backup`). Tools in the image: restic, Postgres
  17 clients, mc. Run records in `_platform.backup_runs`. HTTP API on the stack network only
  (token = the control plane's): `GET /projects/<ref>`, `POST /projects/<ref>/backups`,
  `POST /projects/<ref>/restore {snapshot_id, name}`; `GET /health` answers 503 while a backup
  failed or is overdue (Coolify shows the platform unhealthy).
- **Configuration:** `BACKUP_CONFIG` (YAML/JSON, base64 allowed) = `infra/platform/backups.yaml`,
  put into the platform app's env by the infra sync (`after: none`). The service re-reads it from
  the Coolify API before every run (needs a token that may read values; otherwise it uses the value
  the container started with). Destinations are S3-compatible; per project (by name or ref):
  destination, schedule (daily, UTC), keep, password, enabled. Default 02:30 UTC, keep 7 daily /
  4 weekly / 6 monthly.
- **Per project:** one restic repository `<bucket>/<prefix>/<ref>`, password
  HMAC-SHA256(`encryption_key`, `restic:<ref>`) unless the project sets its own. Contents:
  `pg_dumpall --roles-only`, `pg_dump -Fc` of `postgres` (as `supabase_admin`), the pgsodium root
  key (`pg_read_file`), the bucket `<ref>` mirrored (`mc mirror`, incremental via the `backup-stage`
  volume), and `/data/supa-platform/projects/<ref>`. The platform DB (`_supabase`, `postgres`) is
  the repository `_platform`.
- **Restore** always goes into a new project (control plane creates it): pgsodium key written with
  `lo_from_bytea`/`lo_export`, settings files copied (old project host rewritten), stack restarted
  (Coolify) and awaited by `pg_postmaster_start_time`, then only the roles the new project lacks
  (the dump also sets the passwords of the roles the stack runs on), then
  `pg_restore --clean --if-exists` without the GraphQL entries (a clean restore drops
  `graphql_public.graphql` and its grants), `notify pgrst`, then the files (`<ref>/` key prefix =
  storage TENANT_ID). Tested by hand first: users (sign-in works), RLS, triggers on auth.users,
  Vault secret readable, pg_cron job, storage object, ACLs equal apart from equivalent forms.
- **Lifecycle guard:** restic keeps unchanged data in old pack files, so a bucket rule that deletes
  old objects breaks every snapshot. Each run HEADs the repository's `config` and fails with a clear
  message when S3 answers `x-amz-expiration` (src/backup/s3.ts, SigV4 tested against AWS's example).
- **Studio:** Database → Backups (`IS_MULTI_PROJECT`): `components/interfaces/MultiProject/PlatformBackups.tsx`,
  routes `pages/api/platform/projects/[ref]/backups/{index,restore}.ts`
  (`lib/api/self-hosted/project-backups.ts`, `STUDIO_BACKUP_URL`). No keys are shown or set there.
- **Deleted projects:** a project's backups outlive it by `deleted_project_retention_days`
  (backups.yaml, default 30, 0 = at once). Each tick the service records refs with a successful
  backup that are gone from the registry (`_platform.backup_deleted_projects`: ref, destination of
  the last backup, `deleted_at` = first seen gone) and, once the days have passed, removes
  `<bucket>/<prefix>/<ref>/` with `mc rm --recursive --force` (never anything above the ref; a ref
  must match `[a-z]{20}`). A destination no longer in the config waits; a failure is retried next
  tick. Studio's delete dialog says "Backups of this project are kept for N days, then deleted."
  (`deleted_project_retention_days` in the view). Checked on R2: a ref's folder goes, its
  siblings stay, a missing folder exits 0.

## 20. Polish (2026-10-12)

- **Storage settings apply by themselves.** storage-api reads its env once (`getConfig`), so the
  project's `supabase-storage` command runs it under a small sh loop: every 5 s it compares the
  `cksum` of `/etc/studio-config/storage.env` (a directory bind, so rewrites are seen) and on a
  change stops storage-api and starts it again with the new file, inside the same container (a few
  seconds; an upload at that moment may need a retry). If storage-api dies on its own the loop
  exits with its code and Docker restarts the container. Tested by `test/storage-reload.test.ts`
  (the compose command itself with a fake server) and by hand in `supabase/storage-api:v1.44.2`
  (busybox ash). Studio's storage pages say "Changes apply in a few seconds" on the platform
  (`StorageSettingsNotice.tsx`); a single self-hosted stack still gets the restart notice.
- **Existing projects get template changes with `POST /projects/<ref>/stack`** (control plane,
  token): the current `project-compose.yaml`, rendered for the ref, replaces the Coolify service's
  compose (`PATCH /services/<uuid>` `docker_compose_raw`), then `POST /services/<uuid>/restart`.
  Only ACTIVE_HEALTHY projects (409 otherwise, 404 unknown). The stack restarts (about 20-30 s);
  data, settings and envs stay.
- **Billing:** nothing to hide. Checked live on studio.<platform-domain>: project settings show
  Configuration (General, API Keys, JWT Keys, Log Drains) and Integrations only, ⌘K finds nothing
  for billing/usage/subscription/invoices, the org page has no plan. The self-hosted settings menu
  never had the Billing group (`SettingsMenu.utils.tsx` returns early for `!IS_PLATFORM`; guarded
  by `SettingsMenu.selfhosted.test.tsx`).

import pg from 'pg'

import { loadConfig } from './config.ts'
import { createCoolifyClient } from './coolify.ts'
import { KongGateway, renderKongConfig, type GatewayProject } from './kong.ts'
import { createMinioStorage } from './minio.ts'
import { Provisioner, routedProjects } from './provisioner.ts'
import { createPgRegistry, migrate } from './registry.ts'
import { createApp } from './server.ts'
import { loadTemplate, renderTemplate, serviceEnvs, templateValues } from './template.ts'
import { createRealtimeTenants, createSupavisorTenants } from './tenants.ts'

const config = loadConfig()
const log = (event: string, fields: Record<string, unknown>) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields }))

const pool = new pg.Pool({ connectionString: config.registryDatabaseUrl, max: 5 })
await migrate(pool)
const registry = createPgRegistry(pool, config.secretsKey)

const gateway = new KongGateway({
  ...config.kong,
  load: async () => {
    const out: GatewayProject[] = []
    for (const p of routedProjects(await registry.list())) {
      const secrets = await registry.getSecrets(p.ref)
      if (!secrets) throw new Error(`Secrets for ${p.ref} are missing`)
      out.push({
        ref: p.ref,
        uuid: p.coolify_service_uuid!,
        anonKey: secrets.anon_key,
        serviceKey: secrets.service_key,
      })
    }
    return out
  },
  render: (projects) =>
    renderKongConfig(projects, {
      domainSuffix: config.domainSuffix,
      realtimeUrl: config.realtimeUrl,
    }),
  log,
})

const template = loadTemplate(config.templatePath)
const admin = { adminJwtSecret: config.adminJwtSecret }
const provisioner = new Provisioner({
  registry,
  coolify: createCoolifyClient(config.coolify),
  renderCompose: (ref) =>
    renderTemplate(template, templateValues(ref, config.domainSuffix, config.projectShared)),
  serviceEnvs,
  storage: createMinioStorage(config.minio),
  pooler: createSupavisorTenants({ url: config.supavisorUrl, ...admin }),
  realtime: createRealtimeTenants({ url: config.realtimeUrl, ...admin }),
  gateway,
  healthTimeoutMs: config.healthTimeoutMs,
  pollIntervalMs: config.pollIntervalMs,
  log,
})

// DB-less Kong starts empty after a restart; put the config back within one interval.
const reconcile = () =>
  gateway.reconcile().catch((err: unknown) => log('kong.reconcile_failed', { error: String(err) }))
await reconcile()
const timer = setInterval(reconcile, config.kongReconcileMs)

const resumed = await provisioner.resumeInterrupted()
if (resumed.length) log('provision.resumed', { refs: resumed })

const server = createApp({
  registry,
  provisioner,
  apiToken: config.apiToken,
  domainSuffix: config.domainSuffix,
})
server.listen(config.port, () => log('server.listening', { port: config.port }))

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    clearInterval(timer)
    server.close()
    void pool.end().finally(() => process.exit(0))
  })
}

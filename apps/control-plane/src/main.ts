import pg from 'pg'

import { loadConfig } from './config.ts'
import { createCoolifyClient } from './coolify.ts'
import { Provisioner } from './provisioner.ts'
import { createPgRegistry, migrate } from './registry.ts'
import { createApp } from './server.ts'
import { loadTemplate, renderTemplate, serviceEnvs, templateValues } from './template.ts'

const config = loadConfig()
const log = (event: string, fields: Record<string, unknown>) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields }))

const pool = new pg.Pool({ connectionString: config.registryDatabaseUrl, max: 5 })
await migrate(pool)
const registry = createPgRegistry(pool, config.secretsKey)

const template = loadTemplate(config.templatePath)
const provisioner = new Provisioner({
  registry,
  coolify: createCoolifyClient(config.coolify),
  renderCompose: (ref) =>
    renderTemplate(template, templateValues(ref, config.domainSuffix, config.storage)),
  serviceEnvs: (secrets) => serviceEnvs(secrets, config.storage),
  healthTimeoutMs: config.healthTimeoutMs,
  pollIntervalMs: config.pollIntervalMs,
  log,
})

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
    server.close()
    void pool.end().finally(() => process.exit(0))
  })
}

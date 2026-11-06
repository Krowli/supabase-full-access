// The runner: the one process of the platform with the Docker socket. It deploys project stacks from
// the template baked into its image and nothing else (src/runner/stacks.ts).
//
//   node src/runner/main.ts                     serve the API (src/runner/server.ts) on RUNNER_PORT
//   node src/runner/main.ts adopt <ref> <id>    take over a stack Coolify made under compose project
//                                               <id>: KEY=VALUE secrets on stdin (other keys are
//                                               ignored and named), then start it from the template
//   node src/runner/main.ts render <ref> <id>   print the compose.yaml it would write (no secrets)
import { resolve } from 'node:path'

import { loadTemplate, renderTemplate, templateValues } from '../template.ts'
import { createDocker } from './docker.ts'
import { Pitr } from './pitr.ts'
import { createRunnerServer } from './server.ts'
import { buildStack, STACK_ENV_KEYS } from './stack.ts'
import { Stacks } from './stacks.ts'

const env = process.env
const missing: string[] = []
const req = (name: string) => {
  if (!env[name]) missing.push(name)
  return env[name] ?? ''
}
const [command = 'serve', ref = '', id = ''] = process.argv.slice(2)
const shared = {
  s3Endpoint: req('PROJECT_S3_ENDPOINT'),
  s3Region: env.PROJECT_S3_REGION ?? 'us-east-1',
  imgproxyUrl: req('PROJECT_IMGPROXY_URL'),
}
const domainSuffix = req('PROJECT_DOMAIN_SUFFIX')
const projectsHostDir = req('PROJECTS_HOST_DIR')
const token = command === 'serve' ? req('RUNNER_TOKEN') : ''
if (missing.length) throw new Error(`Missing env: ${missing.join(', ')}`)

const template = loadTemplate(
  env.PROJECT_TEMPLATE_PATH ??
    resolve(import.meta.dirname, '../../../../deploy/platform/project-compose.yaml')
)
const render = (r: string) =>
  renderTemplate(template, templateValues(r, domainSuffix, shared, projectsHostDir))
const log = (event: string, fields: Record<string, unknown>) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields }))
const docker = createDocker()
const sharedNetwork = env.RUNNER_SHARED_NETWORK ?? 'coolify'
const stacks = new Stacks({
  dir: env.RUNNER_STACKS_DIR ?? '/data/supa-runner/stacks',
  sharedNetwork,
  render,
  docker,
})

if (command === 'render') {
  process.stdout.write(buildStack(render(ref), id).compose)
} else if (command === 'adopt') {
  let input = ''
  for await (const chunk of process.stdin) input += chunk
  const envs: Record<string, string> = {}
  const ignored: string[] = []
  for (const line of input.split('\n')) {
    const at = line.indexOf('=')
    if (at <= 0 || line.startsWith('#')) continue
    const key = line.slice(0, at)
    if ((STACK_ENV_KEYS as readonly string[]).includes(key))
      envs[key] = line.slice(at + 1).replace(/^'(.*)'$|^"(.*)"$/, '$1$2')
    else ignored.push(key)
  }
  const got = await stacks.create(ref, ref, id)
  await stacks.setEnvs(got, envs)
  await stacks.start(got)
  log('stack.adopted', { id: got, ref, keys: Object.keys(envs), ignored })
  const state = await stacks.get(got)
  log('stack.status', { id: got, status: state?.status })
} else if (command === 'serve') {
  const server = createRunnerServer({
    stacks,
    pitr: new Pitr({ stacks, docker, sharedNetwork }),
    token,
    log,
  })
  const port = Number(env.RUNNER_PORT ?? 8080)
  server.listen(port, () => log('runner.listening', { port }))
  for (const signal of ['SIGTERM', 'SIGINT'] as const)
    process.on(signal, () => server.close(() => process.exit(0)))
} else {
  throw new Error(`Unknown command ${command}`)
}

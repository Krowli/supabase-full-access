import { execFile } from 'node:child_process'

import type { Docker } from './stacks.ts'

/** Runs the docker CLI without a shell: arguments are passed as they are, never interpolated. */
function docker(args: string[], timeoutMs = 10 * 60_000, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('docker', args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        // stderr of compose can quote compose lines, never .env values (they are not in compose.yaml);
        // stdin (wal-g's settings) is never echoed.
        reject(new Error(`docker ${args.slice(0, 3).join(' ')} failed: ${String(stderr).trim().slice(-500)}`))
        return
      }
      resolve(String(stdout))
    })
    child.stdin?.end(input ?? '')
  })
}

/** The Docker of this host, through the socket the runner container is given. */
export function createDocker(): Docker {
  return {
    compose(id, dir, args) {
      return docker(['compose', '-p', id, '--project-directory', dir, '-f', `${dir}/compose.yaml`, ...args])
    },
    async ensureNetwork(name) {
      try {
        await docker(['network', 'inspect', name], 30_000)
      } catch {
        await docker(['network', 'create', name], 30_000)
      }
    },
    async removeNetwork(name) {
      try {
        await docker(['network', 'inspect', name], 30_000)
      } catch {
        return
      }
      await docker(['network', 'rm', name], 30_000)
    },
    async attach(container, network, alias) {
      const nets = await docker(['inspect', '-f', '{{json .NetworkSettings.Networks}}', container], 30_000)
      if (Object.hasOwn(JSON.parse(nets) as object, network)) return
      await docker(['network', 'connect', '--alias', alias, network, container], 30_000)
    },
    async projectHasContainers(id) {
      const out = await docker(
        ['ps', '-a', '-q', '--filter', `label=com.docker.compose.project=${id}`],
        30_000
      )
      return out.trim().length > 0
    },
    exec(container, user, args, input, timeoutMs = 10 * 60_000) {
      return docker(['exec', ...(input === undefined ? [] : ['-i']), '-u', user, container, ...args], timeoutMs, input)
    },
    async signal(container, signal) {
      await docker(['kill', '--signal', signal, container], 30_000)
    },
    async imageOf(container) {
      return (await docker(['inspect', '-f', '{{.Config.Image}}', container], 30_000)).trim()
    },
    async run(args) {
      await docker(['run', '-d', ...args], 10 * 60_000)
    },
    async remove(container, volumes) {
      await docker(['rm', '-f', '-v', container], 60_000).catch((err: Error) => {
        if (!/No such container/i.test(err.message)) throw err
      })
      for (const volume of volumes)
        await docker(['volume', 'rm', '-f', volume], 60_000)
    },
    async running(container) {
      const out = await docker(['inspect', '-f', '{{.State.Running}}', container], 30_000).catch(() => 'false')
      return out.trim() === 'true'
    },
    async logs(container, lines) {
      // docker logs prints the container's stderr on its own stderr: fold both into the answer.
      return new Promise((resolve) => {
        execFile('docker', ['logs', '--tail', String(lines), container], { timeout: 30_000 }, (_err, stdout, stderr) =>
          resolve(`${String(stdout)}${String(stderr)}`)
        )
      })
    },
  }
}

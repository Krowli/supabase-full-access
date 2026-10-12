import { chmod, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * The host directories Studio writes a project's settings into, and the project stack reads them
 * from (deploy/platform/SPEC.md §16):
 *
 *   <root>/<ref>/gotrue   99_studio.env, bound read-only into supabase-auth at /etc/gotrue
 *   <root>/<ref>/storage  storage.env, bound read-only into supabase-storage at /etc/studio-config
 *   <root>/<ref>/state    Studio's own record (auth-config.json, storage-config.json, …)
 *
 * Studio sees <root> as /data/pieowl/projects (project-context.ts); the control plane sees it at
 * the same path as the host (the platform compose binds it so). The control plane runs as uid 1000,
 * which is also GoTrue's user, so what it creates is owned 1000:1000. They are made before the
 * stack first starts: a bind whose source is missing would be created by Docker as root.
 */
export interface ProjectDirs {
  ensure(ref: string): Promise<void>
  /** Removes <root>/<ref> and everything Studio wrote into it. Missing is fine. */
  remove(ref: string): Promise<void>
}

const SUBDIRS = { gotrue: 0o755, storage: 0o755, state: 0o700 } as const

// A ref names a directory here: nothing that could climb out of <root>.
const REF = /^[a-z0-9][a-z0-9-]{0,62}$/

function projectDir(root: string, ref: string): string {
  if (!REF.test(ref)) throw new Error(`Refusing a project directory for ref ${JSON.stringify(ref)}`)
  return join(root, ref)
}

export function createProjectDirs(root: string): ProjectDirs {
  return {
    async ensure(ref) {
      const dir = projectDir(root, ref)
      await mkdir(dir, { recursive: true })
      await chmod(dir, 0o750)
      for (const [name, mode] of Object.entries(SUBDIRS)) {
        await mkdir(join(dir, name), { recursive: true })
        // mkdir's mode is masked by the umask; chmod is not.
        await chmod(join(dir, name), mode)
      }
    },
    async remove(ref) {
      await rm(projectDir(root, ref), { recursive: true, force: true })
    },
  }
}

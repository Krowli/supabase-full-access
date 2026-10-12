import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createProjectDirs } from '../src/project-dirs.ts'

const ref = 'abcdefghijklmnopqrst'
let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'project-dirs-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const mode = (path: string) => statSync(path).mode & 0o777

describe('createProjectDirs', () => {
  it('creates <ref>/{gotrue,storage,state} with their modes, and again without error', async () => {
    const dirs = createProjectDirs(root)
    await dirs.ensure(ref)
    await dirs.ensure(ref)
    expect(mode(join(root, ref))).toBe(0o750)
    expect(mode(join(root, ref, 'gotrue'))).toBe(0o755)
    expect(mode(join(root, ref, 'storage'))).toBe(0o755)
    expect(mode(join(root, ref, 'state'))).toBe(0o700)
  })

  it('removes <ref> with what Studio wrote into it, leaves other projects, and accepts a missing one', async () => {
    const dirs = createProjectDirs(root)
    await dirs.ensure(ref)
    await dirs.ensure('otherprojectrefxxxxx')
    writeFileSync(join(root, ref, 'gotrue', '99_studio.env'), 'GOTRUE_SITE_URL="x"\n')
    writeFileSync(join(root, ref, 'state', 'auth-config.json'), '{}')
    await dirs.remove(ref)
    expect(existsSync(join(root, ref))).toBe(false)
    expect(existsSync(join(root, 'otherprojectrefxxxxx', 'gotrue'))).toBe(true)
    await dirs.remove(ref)
  })

  it('refuses a ref that is not one directory name', async () => {
    const dirs = createProjectDirs(root)
    for (const bad of ['..', '../etc', 'a/b', '', '.hidden', 'UPPER'])
      await expect(dirs.remove(bad)).rejects.toThrow(/Refusing/)
    await expect(dirs.ensure('../x')).rejects.toThrow(/Refusing/)
  })
})

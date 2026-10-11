// Per-project storage in the shared MinIO: bucket <ref> and a service account (access key)
// whose policy reaches only that bucket. MinIO's admin API encrypts its payloads (madmin), so
// the control plane drives the `mc` client that its image bundles instead of speaking it.

import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface ObjectStorage {
  /** Creates the bucket and the scoped key if missing. */
  ensureBucket(ref: string, accessKey: string, secretKey: string): Promise<void>
  /** Deletes the scoped key and the bucket with every object in it. Missing ones are fine. */
  removeBucket(ref: string, accessKey: string): Promise<void>
}

export type MinioConfig = { url: string; rootUser: string; rootPassword: string; mcPath?: string }

type McResult = { ok: boolean; error: string }

export function bucketPolicy(ref: string) {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: ['s3:*'],
        Resource: [`arn:aws:s3:::${ref}`, `arn:aws:s3:::${ref}/*`],
      },
    ],
  }
}

export function createMinioStorage(config: MinioConfig): ObjectStorage {
  const url = new URL(config.url)
  url.username = encodeURIComponent(config.rootUser)
  url.password = encodeURIComponent(config.rootPassword)
  const env = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    MC_HOST_platform: url.toString().replace(/\/+$/, ''),
    MC_CONFIG_DIR: join(tmpdir(), '.mc'),
  }

  // stdout is never logged: `svcacct add` prints the secret key back. Errors carry only mc's
  // error message, which names the resource, not the credentials.
  const mc = (args: string[]) =>
    new Promise<McResult>((resolve) => {
      execFile(
        config.mcPath ?? 'mc',
        ['--json', '--no-color', ...args],
        { env, timeout: 60_000 },
        (err, stdout) => {
          if (!err) return resolve({ ok: true, error: '' })
          const messages = stdout
            .split('\n')
            .filter(Boolean)
            .map((line) => {
              try {
                const parsed = JSON.parse(line) as {
                  error?: { message?: string; cause?: { message?: string } }
                }
                return [parsed.error?.message, parsed.error?.cause?.message]
                  .filter(Boolean)
                  .join(': ')
              } catch {
                return ''
              }
            })
            .filter(Boolean)
          resolve({ ok: false, error: messages.join('; ') || err.message.split('\n')[0] })
        }
      )
    })

  const must = (what: string, r: McResult) => {
    if (!r.ok) throw new Error(`MinIO ${what}: ${r.error}`)
  }
  const missing = (r: McResult) =>
    /not (exist|found)|does not exist|NoSuchBucket|specified service account/i.test(r.error)

  return {
    async ensureBucket(ref, accessKey, secretKey) {
      must(`create bucket ${ref}`, await mc(['mb', '--ignore-existing', `platform/${ref}`]))
      if ((await mc(['admin', 'user', 'svcacct', 'info', 'platform', accessKey])).ok) return
      const dir = await mkdtemp(join(tmpdir(), 'policy-'))
      try {
        const policy = join(dir, 'policy.json')
        await writeFile(policy, JSON.stringify(bucketPolicy(ref)), { mode: 0o600 })
        must(
          `create access key for ${ref}`,
          await mc([
            'admin',
            'user',
            'svcacct',
            'add',
            'platform',
            config.rootUser,
            '--access-key',
            accessKey,
            '--secret-key',
            secretKey,
            '--policy',
            policy,
          ])
        )
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },

    async removeBucket(ref, accessKey) {
      const key = await mc(['admin', 'user', 'svcacct', 'rm', 'platform', accessKey])
      if (!key.ok && !missing(key)) must(`delete access key for ${ref}`, key)
      const bucket = await mc(['rb', '--force', `platform/${ref}`])
      if (!bucket.ok && !missing(bucket)) must(`delete bucket ${ref}`, bucket)
    },
  }
}

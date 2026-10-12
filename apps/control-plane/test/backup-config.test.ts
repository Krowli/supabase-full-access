import { describe, expect, it } from 'vitest'

import {
  derivePassword,
  forgetArgs,
  parseBackupConfig,
  repositoryUrl,
  resolvePolicy,
  resticEnv,
  type BackupConfig,
} from '../src/backup/config.ts'

const YAML = `
destinations:
  r2-main:
    type: s3
    endpoint: https://acc.eu.r2.cloudflarestorage.com
    bucket: platform-backups
    prefix: supa
    access_key_id: AKID
    secret_access_key: SECRET
  other:
    type: s3
    endpoint: https://s3.example.com/
    bucket: b2
    region: eu-central-1
    access_key_id: AK2
    secret_access_key: SK2
default:
  destination: r2-main
encryption_key: 0123456789abcdef0123456789abcdef
projects:
  taxroam:
    destination: other
    keep: { daily: 14 }
  aaaaaaaaaaaaaaaaaaaa:
    schedule: "04:15"
    password: explicit-password-for-this-project
  paused:
    enabled: false
`

const parse = (raw = YAML) => parseBackupConfig(raw)

describe('parseBackupConfig', () => {
  it('reads YAML, JSON and base64 of either', () => {
    const fromYaml = parse()
    expect(parseBackupConfig(JSON.stringify(fromYaml))).toEqual(fromYaml)
    expect(parseBackupConfig(Buffer.from(YAML).toString('base64'))).toEqual(fromYaml)
  })

  it('fills the defaults: 02:30 UTC, 7 daily, 4 weekly, 6 monthly', () => {
    const c = parse()
    expect(c.default.schedule).toBe('02:30')
    expect(c.default.keep).toEqual({ daily: 7, weekly: 4, monthly: 6 })
  })

  it('strips trailing slashes from endpoints', () => {
    expect(parse().destinations.other.endpoint).toBe('https://s3.example.com')
  })

  it.each([
    ['no destinations', 'default: {destination: x}\nencryption_key: 0123456789abcdef0123456789abcdef'],
    ['unknown default destination', YAML.replace('destination: r2-main', 'destination: nope')],
    ['unknown project destination', YAML.replace('destination: other', 'destination: nope')],
    ['short encryption key', YAML.replace('0123456789abcdef0123456789abcdef', 'short')],
    ['bad schedule', YAML.replace('"04:15"', '"25:00"')],
    ['unsupported type', YAML.replace('type: s3\n    endpoint: https://s3', 'type: ftp\n    endpoint: https://s3')],
    ['http endpoint', YAML.replace('https://s3.example.com/', 'ftp://s3.example.com')],
    ['missing secret', YAML.replace('    secret_access_key: SK2\n', '')],
    ['negative keep', YAML.replace('daily: 14', 'daily: -1')],
    ['not an object', '42'],
  ])('rejects %s', (_, raw) => {
    expect(() => parseBackupConfig(raw)).toThrow()
  })

  it('never echoes a value in its errors', () => {
    try {
      parseBackupConfig(YAML.replace('destination: other', 'destination: SECRET'))
      throw new Error('should have thrown')
    } catch (err) {
      expect(String(err)).not.toContain('SK2')
    }
  })
})

describe('resolvePolicy', () => {
  const config: BackupConfig = parse()

  it('uses the defaults for a project without an entry', () => {
    const p = resolvePolicy(config, { ref: 'bbbbbbbbbbbbbbbbbbbb', name: 'pieowl' })
    expect(p).toMatchObject({
      enabled: true,
      destinationName: 'r2-main',
      schedule: '02:30',
      keep: { daily: 7, weekly: 4, monthly: 6 },
      repository: 's3:https://acc.eu.r2.cloudflarestorage.com/platform-backups/supa/bbbbbbbbbbbbbbbbbbbb',
    })
    expect(p.password).toBe(derivePassword(config.encryption_key, 'bbbbbbbbbbbbbbbbbbbb'))
  })

  it('finds a project entry by name, merging keep with the defaults', () => {
    const p = resolvePolicy(config, { ref: 'cccccccccccccccccccc', name: 'taxroam' })
    expect(p.destinationName).toBe('other')
    expect(p.keep).toEqual({ daily: 14, weekly: 4, monthly: 6 })
    expect(p.repository).toBe('s3:https://s3.example.com/b2/cccccccccccccccccccc')
  })

  it('finds a project entry by ref; an explicit password wins', () => {
    const p = resolvePolicy(config, { ref: 'aaaaaaaaaaaaaaaaaaaa', name: 'whatever' })
    expect(p.schedule).toBe('04:15')
    expect(p.password).toBe('explicit-password-for-this-project')
  })

  it('reports a project switched off', () => {
    expect(resolvePolicy(config, { ref: 'dddddddddddddddddddd', name: 'paused' }).enabled).toBe(false)
  })

  it('backs up the platform itself to the default destination under "platform"', () => {
    const p = resolvePolicy(config, { ref: '_platform', name: '_platform' })
    expect(p.repository).toBe('s3:https://acc.eu.r2.cloudflarestorage.com/platform-backups/supa/_platform')
  })
})

describe('derivePassword', () => {
  it('is stable per ref and differs between refs', () => {
    const key = '0123456789abcdef0123456789abcdef'
    expect(derivePassword(key, 'a')).toBe(derivePassword(key, 'a'))
    expect(derivePassword(key, 'a')).not.toBe(derivePassword(key, 'b'))
    expect(derivePassword(key, 'a')).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('restic arguments', () => {
  it('builds the environment for an S3 destination', () => {
    const config = parse()
    expect(resticEnv(config.destinations.other, 'pw')).toEqual({
      RESTIC_PASSWORD: 'pw',
      AWS_ACCESS_KEY_ID: 'AK2',
      AWS_SECRET_ACCESS_KEY: 'SK2',
      AWS_DEFAULT_REGION: 'eu-central-1',
    })
    expect(resticEnv(config.destinations['r2-main'], 'pw').AWS_DEFAULT_REGION).toBe('auto')
  })

  it('turns retention into forget flags, skipping zeros', () => {
    expect(forgetArgs({ daily: 7, weekly: 0, monthly: 6 })).toEqual([
      '--keep-daily',
      '7',
      '--keep-monthly',
      '6',
    ])
  })

  it('names repositories without double slashes', () => {
    expect(
      repositoryUrl(
        { type: 's3', endpoint: 'https://x', bucket: 'b', access_key_id: 'a', secret_access_key: 's' },
        'ref'
      )
    ).toBe('s3:https://x/b/ref')
  })
})

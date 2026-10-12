import { describe, expect, it } from 'vitest'

import { benignRestoreError, filterRoles, filterToc, rewriteProjectRef } from '../src/backup/restore-plan.ts'
import { healthProblems, isDue, type LastRuns } from '../src/backup/schedule.ts'

const at = (iso: string) => new Date(iso)

describe('isDue', () => {
  it('is due once the day has passed the schedule and no scheduled run started today', () => {
    expect(isDue(at('2026-10-12T02:29:59Z'), '02:30', null)).toBe(false)
    expect(isDue(at('2026-10-12T02:30:00Z'), '02:30', null)).toBe(true)
    expect(isDue(at('2026-10-12T02:31:00Z'), '02:30', at('2026-10-11T02:30:05Z'))).toBe(true)
    expect(isDue(at('2026-10-12T23:00:00Z'), '02:30', at('2026-10-12T02:30:05Z'))).toBe(false)
  })

  it('does not run a missed day twice after a long outage', () => {
    // Started at 02:30 on the 12th, failed; the next scheduled run is on the 13th.
    expect(isDue(at('2026-10-12T05:00:00Z'), '02:30', at('2026-10-12T02:31:00Z'))).toBe(false)
  })
})

describe('healthProblems', () => {
  const now = at('2026-10-12T12:00:00Z')
  const ok: LastRuns = { lastStarted: at('2026-10-12T02:30:00Z'), lastStatus: 'succeeded', lastSuccess: at('2026-10-12T02:35:00Z') }

  it('is healthy after a successful run today', () => {
    expect(healthProblems(now, [{ id: 'p', schedule: '02:30', createdAt: at('2026-01-01T00:00:00Z'), runs: ok }])).toEqual([])
  })

  it('reports a failed last run', () => {
    const runs = { ...ok, lastStatus: 'failed' as const, lastError: 'boom' }
    expect(healthProblems(now, [{ id: 'p', schedule: '02:30', createdAt: at('2026-01-01T00:00:00Z'), runs }])).toEqual([
      'p: last backup failed: boom',
    ])
  })

  it('reports no success for more than a day past the schedule', () => {
    const runs = { lastStarted: null, lastStatus: null, lastSuccess: at('2026-10-10T02:35:00Z') }
    expect(healthProblems(now, [{ id: 'p', schedule: '02:30', createdAt: at('2026-01-01T00:00:00Z'), runs }])).toEqual([
      'p: no successful backup since 2026-10-10T02:35:00.000Z',
    ])
  })

  it('gives a new project until its first schedule plus a grace hour', () => {
    const runs = { lastStarted: null, lastStatus: null, lastSuccess: null }
    const fresh = { id: 'p', schedule: '02:30', createdAt: at('2026-10-12T10:00:00Z'), runs }
    expect(healthProblems(now, [fresh])).toEqual([])
    expect(healthProblems(at('2026-10-13T04:00:00Z'), [fresh])).toEqual(['p: never backed up'])
  })
})

describe('filterRoles', () => {
  const dump = `--
-- Roles
--

CREATE ROLE anon;
ALTER ROLE anon WITH NOSUPERUSER INHERIT NOCREATEROLE NOCREATEDB NOLOGIN NOREPLICATION NOBYPASSRLS;
CREATE ROLE appuser;
ALTER ROLE appuser WITH NOSUPERUSER INHERIT NOCREATEROLE NOCREATEDB LOGIN NOREPLICATION NOBYPASSRLS PASSWORD 'SCRAM-SHA-256$4096:x';
CREATE ROLE "Mixed Case";
ALTER ROLE "Mixed Case" WITH LOGIN;
ALTER ROLE supabase_admin WITH SUPERUSER PASSWORD 'SCRAM-SHA-256$4096:y';
ALTER ROLE authenticator SET session_preload_libraries TO 'safeupdate';
ALTER ROLE appuser SET search_path TO 'public';
COMMENT ON ROLE appuser IS 'app';

--
-- Role memberships
--

GRANT anon TO authenticator WITH INHERIT TRUE GRANTED BY supabase_admin;
GRANT authenticated TO appuser WITH INHERIT TRUE GRANTED BY supabase_admin;
GRANT appuser TO postgres WITH INHERIT TRUE GRANTED BY supabase_admin;
`
  const existing = new Set(['anon', 'authenticated', 'authenticator', 'postgres', 'supabase_admin'])

  it('keeps only roles the new project lacks, and memberships that involve them', () => {
    expect(filterRoles(dump, existing).trim().split('\n')).toEqual([
      'CREATE ROLE appuser;',
      "ALTER ROLE appuser WITH NOSUPERUSER INHERIT NOCREATEROLE NOCREATEDB LOGIN NOREPLICATION NOBYPASSRLS PASSWORD 'SCRAM-SHA-256$4096:x';",
      'CREATE ROLE "Mixed Case";',
      'ALTER ROLE "Mixed Case" WITH LOGIN;',
      "ALTER ROLE appuser SET search_path TO 'public';",
      "COMMENT ON ROLE appuser IS 'app';",
      'GRANT authenticated TO appuser WITH INHERIT TRUE GRANTED BY supabase_admin;',
      'GRANT appuser TO postgres WITH INHERIT TRUE GRANTED BY supabase_admin;',
    ])
  })

  it('never touches the passwords of the roles the new project runs on', () => {
    expect(filterRoles(dump, existing)).not.toContain('supabase_admin WITH')
  })
})

describe('filterToc', () => {
  it('leaves out what a fresh project already has and a clean restore would break', () => {
    const toc = [
      ';',
      '; Archive created at 2026-10-12',
      '14; 2615 16686 SCHEMA - graphql supabase_admin',
      '8; 3079 16741 EXTENSION - pg_graphql ',
      '369; 1255 16680 FUNCTION extensions grant_pg_graphql_access() supabase_admin',
      '4253; 0 0 ACL graphql_public FUNCTION graphql("operationName" text) supabase_admin',
      '3617; 3466 16683 EVENT TRIGGER - issue_pg_graphql_access supabase_admin',
      '5000; 1259 17000 TABLE public items postgres',
      '5001; 0 17000 TABLE DATA public graphql_notes postgres',
    ].join('\n')
    expect(filterToc(toc).split('\n')).toEqual([
      ';',
      '; Archive created at 2026-10-12',
      '5000; 1259 17000 TABLE public items postgres',
      '5001; 0 17000 TABLE DATA public graphql_notes postgres',
    ])
  })
})

describe('benignRestoreError', () => {
  it.each([
    'ERROR:  unrecognized configuration parameter "transaction_timeout"',
    'ERROR:  schema "extensions" already exists',
    'ERROR:  cannot drop schema extensions because other objects depend on it',
  ])('ignores %s', (e) => expect(benignRestoreError(e)).toBe(true))

  it('keeps real errors', () => {
    expect(benignRestoreError('ERROR:  role "appuser" does not exist')).toBe(false)
  })
})

describe('rewriteProjectRef', () => {
  it('points the old project URL at the new project, leaving other text alone', () => {
    const text = 'GOTRUE_SITE_URL=https://old.supa.example.com\nGOTRUE_URI_ALLOW_LIST=https://app.example.com,https://old.supa.example.com/x\n'
    expect(rewriteProjectRef(text, 'old', 'new', 'supa.example.com')).toBe(
      'GOTRUE_SITE_URL=https://new.supa.example.com\nGOTRUE_URI_ALLOW_LIST=https://app.example.com,https://new.supa.example.com/x\n'
    )
  })
})

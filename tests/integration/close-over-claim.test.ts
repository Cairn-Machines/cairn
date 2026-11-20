import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * `PATCH /tasks/{ref}` closing a task another holder's live claim covers
 * (CAIRN-456), against a real database and the actual route.
 */

const hooks = vi.hoisted(() => ({
  actor: null as null | Record<string, unknown>,
  afterFirstRead: null as null | (() => Promise<void>),
}))

vi.mock('@/lib/api/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/auth')>()
  return { ...actual, authenticate: async () => hooks.actor }
})

// Lets a test land a claim in the window between the route's read and its write.
vi.mock('@/lib/api/tasks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/tasks')>()
  return {
    ...actual,
    findTask: async (...args: Parameters<typeof actual.findTask>) => {
      const task = await actual.findTask(...args)
      const hook = hooks.afterFirstRead
      hooks.afterFirstRead = null
      if (hook) await hook()
      return task
    },
  }
})

import { pool } from '@/lib/db/client'
import { PATCH as patchTask } from '@/app/api/v1/tasks/[ref]/route'

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for integration tests')

const ownerId = randomUUID()
const projectId = randomUUID()
const KEY = `CC${String(Date.now()).slice(-6)}`
const ME = 'claude-code · Closer'
const OTHER = 'codex · Holder'
let number = 0

const addTask = async (claim: {
  by?: string | null; session?: string | null; beatSecondsAgo?: number
} = {}) => {
  number += 1
  const id = randomUUID()
  await pool().query(
    `insert into tasks (id, project_id, number, title, actor_type, actor_id, status,
                        claimed_by, claimed_session, claimed_at, heartbeat_at)
     values ($1,$2,$3,'Close over claim','agent',$4,'doing',$5,$6,
             case when $5::text is null then null else now() end,
             case when $5::text is null then null else now() - make_interval(secs => $7::int) end)`,
    [id, projectId, number, ME, claim.by ?? null, claim.session ?? null, claim.beatSecondsAgo ?? 30],
  )
  return { id, ref: `${KEY}-${number}` }
}

const as = (sessionId: string | null) => {
  hooks.actor = {
    userId: ownerId, actorType: 'agent', actorId: ME, userDisplayName: 'Closer',
    role: 'admin', rateKey: `close-over-claim-${randomUUID()}`, sessionId,
  }
}

const patch = async (ref: string, body: unknown) => {
  const response = await patchTask(
    new Request(`https://cairn.example.test/api/v1/tasks/${ref}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ ref }) },
  )
  return { status: response.status, json: await response.json() }
}

const close = (ref: string, extra: Record<string, unknown> = {}, status = 'done') =>
  patch(ref, { status, resolution: 'closed in test', ...extra })

const row = async (id: string) =>
  (await pool().query(
    'select status, resolution, claimed_by, claimed_session, claimed_at, heartbeat_at from tasks where id = $1',
    [id],
  )).rows[0] as Record<string, unknown>

const notes = async (id: string) =>
  (await pool().query('select note, actor_id from task_notes where task_id = $1', [id])).rows as
    { note: string; actor_id: string }[]

beforeAll(async () => {
  await pool().query('insert into app_users (id, email, encrypted_password, role) values ($1,$2,$3,$4)', [
    ownerId, `close-over-claim-${ownerId}@example.test`, 'not-used', 'admin',
  ])
  await pool().query(`insert into projects (id, owner_user_id, key, title) values ($1,$2,$3,'Close over claim')`, [
    projectId, ownerId, KEY,
  ])
})

afterAll(async () => {
  await pool().query('delete from task_activity_events where owner_user_id = $1', [ownerId])
  await pool().query('delete from projects where owner_user_id = $1', [ownerId])
  await pool().query('delete from app_users where id = $1', [ownerId])
  await pool().end()
})

describe('closing over a live claim', () => {
  it('AC1 refuses done and cancel over another actor, leaving status, resolution and claim', async () => {
    as('session-a')
    for (const status of ['done', 'cancelled']) {
      const task = await addTask({ by: OTHER, session: 'theirs', beatSecondsAgo: 120 })
      const before = await row(task.id)
      const result = await close(task.ref, {}, status)
      expect(result.status).toBe(409)
      expect(result.json.code).toBe('already_claimed')
      expect(result.json.error).toMatch(new RegExp(`^Held by ${OTHER}, last heartbeat 2m ago\\. .*--override-claim`))
      expect(result.json.claimedBy).toBe(OTHER)
      expect(await row(task.id)).toEqual(before)
      expect(await notes(task.id)).toEqual([])
    }
  })

  it('AC2 refuses another session of the caller\'s own actor, and not a missing session', async () => {
    as('session-a')
    const other = await addTask({ by: ME, session: 'session-b' })
    const refused = await close(other.ref)
    expect(refused.status).toBe(409)
    expect(refused.json.code).toBe('already_claimed')
    expect((await row(other.id)).status).toBe('doing')

    const unnamed = await addTask({ by: ME, session: null })
    expect((await close(unnamed.ref)).status).toBe(200)
  })

  it('AC3 closes with overrideClaim, clears the claim and writes one note naming both', async () => {
    as('session-a')
    for (const status of ['done', 'cancelled']) {
      const task = await addTask({ by: OTHER, session: 'theirs' })
      // A forged name in the request must not reach the note.
      const result = await close(task.ref, { overrideClaim: true, actor: 'someone-else', claimedBy: 'forged' }, status)
      expect(result.status).toBe(200)
      expect(await row(task.id)).toMatchObject({
        status, claimed_by: null, claimed_session: null, claimed_at: null, heartbeat_at: null,
      })
      const written = await notes(task.id)
      expect(written).toHaveLength(1)
      expect(written[0]!.actor_id).toBe(ME)
      expect(written[0]!.note).toBe(
        `Closed over a live claim: ${ME} overrode ${OTHER} (session theirs) with --override-claim.`,
      )
    }
  })

  it('AC4 closes an unclaimed, own or stale-leased task as before, with no note even when the flag is passed', async () => {
    as('session-a')
    const free = await addTask()
    const own = await addTask({ by: ME, session: 'session-a' })
    const stale = await addTask({ by: OTHER, session: 'theirs', beatSecondsAgo: 16 * 60 })
    const flagged = await addTask({ by: OTHER, session: 'theirs', beatSecondsAgo: 16 * 60 })
    for (const task of [free, own, stale]) {
      expect((await close(task.ref)).status).toBe(200)
      expect((await row(task.id)).claimed_by).toBeNull()
      expect(await notes(task.id)).toEqual([])
    }
    expect((await close(flagged.ref, { overrideClaim: true })).status).toBe(200)
    expect(await notes(flagged.id)).toEqual([])
  })

  it('AC7 answers 409 when a claim lands between the read and the close', async () => {
    as('session-a')
    const free = await addTask()
    hooks.afterFirstRead = async () => {
      await pool().query(
        `update tasks set claimed_by = $2, claimed_session = 'theirs', claimed_at = now(), heartbeat_at = now() where id = $1`,
        [free.id, OTHER],
      )
    }
    const lost = await close(free.ref)
    expect(lost.status).toBe(409)
    expect(lost.json.code).toBe('already_claimed')
    expect(await row(free.id)).toMatchObject({ status: 'doing', claimed_by: OTHER })

    const stale = await addTask({ by: OTHER, session: 'theirs', beatSecondsAgo: 16 * 60 })
    hooks.afterFirstRead = async () => {
      await pool().query('update tasks set heartbeat_at = now() where id = $1', [stale.id])
    }
    const revived = await close(stale.ref)
    expect(revived.status).toBe(409)
    expect((await row(stale.id)).status).toBe('doing')
  })

  it('AC1 AC3 closing with a labelPatch is refused over a live claim, and applies labels with the flag', async () => {
    as('session-a')
    const task = await addTask({ by: OTHER, session: 'theirs' })
    const refused = await close(task.ref, { labelPatch: { add: ['tagged'] } })
    expect(refused.status).toBe(409)
    expect(refused.json.code).toBe('already_claimed')
    expect(await row(task.id)).toMatchObject({ status: 'doing', claimed_by: OTHER })

    const allowed = await close(task.ref, { labelPatch: { add: ['tagged'] }, overrideClaim: true })
    expect(allowed.status).toBe(200)
    expect(allowed.json.data.labels).toContain('tagged')
    expect(await row(task.id)).toMatchObject({ status: 'done', claimed_by: null, heartbeat_at: null })
    expect(await notes(task.id)).toHaveLength(1)

    const free = await addTask()
    hooks.afterFirstRead = async () => {
      await pool().query(
        `update tasks set claimed_by = $2, claimed_session = 'theirs', claimed_at = now(), heartbeat_at = now() where id = $1`,
        [free.id, OTHER],
      )
    }
    const lost = await close(free.ref, { labelPatch: { add: ['tagged'] } })
    expect(lost.status).toBe(409)
    expect(await row(free.id)).toMatchObject({ status: 'doing', claimed_by: OTHER })
  })

  it('AC9 never takes the previous holder from the request', async () => {
    as('session-a')
    const task = await addTask({ by: OTHER, session: null })
    await close(task.ref, { overrideClaim: true, claimed_by: 'forged · Name', claimedBy: 'forged · Name' })
    const [only] = await notes(task.id)
    expect(only!.note).toContain(OTHER)
    expect(only!.note).not.toContain('forged')
  })
})

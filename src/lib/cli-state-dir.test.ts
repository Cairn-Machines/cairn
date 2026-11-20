import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * Cairn's mutable state (the outbox and its siblings, the acted log, the
 * caches) lives in ~/.cairn/state/<instance>/, apart from the credentials, so an
 * agent that may write only that directory can still queue a write while the
 * server is down.
 *
 * The CLI is a script, so each case spawns it (that is why the titles say
 * "spawned"). Nothing else is real: `fetch` is replaced by a preload that
 * either refuses the connection or records the request and answers locally, so
 * no server or network is involved. "Only the state directory writable" is a
 * chmod 0500 on ~/.cairn and the instance directory, restored in cleanup.
 */

const KEY = 'test-key'
const KEY_ID = createHash('sha256').update(KEY).digest('hex').slice(0, 24)
const BASE = 'http://cairn.invalid'
const canRestrict = process.getuid?.() !== 0

const directories: string[] = []
const restore: string[] = []
afterEach(async () => {
  await Promise.all(restore.splice(0).map((p) => chmod(p, 0o700).catch(() => undefined)))
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const PRELOAD = `
import { appendFileSync } from 'node:fs'
globalThis.fetch = async (url, init = {}) => {
  if (process.env.FAKE_SERVER === 'down') throw new TypeError('fetch failed')
  const headers = Object.fromEntries(new Headers(init.headers ?? {}).entries())
  appendFileSync(process.env.SEEN_FILE, JSON.stringify({
    method: init.method ?? 'GET',
    url: String(url),
    key: headers['idempotency-key'] ?? null,
    body: String(init.body ?? ''),
  }) + '\\n')
  const data = /\\/api\\/v1\\/projects$/.test(String(url)) ? [{ key: 'WORK' }] : { id: 'x', ref: 'CAIRN-1' }
  return new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { 'content-type': 'application/json' } })
}
`

type World = {
  root: string
  home: string
  cairn: string
  /** Where an older CLI kept the outbox: the top of ~/.cairn, or the instance directory. */
  legacy: string
  /** Where this CLI keeps it now. */
  state: string
  seenFile: string
  preload: string
  env: Record<string, string>
}

const world = async ({ instance }: { instance?: string } = {}): Promise<World> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cairn-state-')))
  directories.push(root)
  const home = join(root, 'home')
  const cairn = join(home, '.cairn')
  await mkdir(cairn, { recursive: true })
  const preload = join(root, 'preload.mjs')
  await writeFile(preload, PRELOAD)
  const base = { root, home, cairn, preload, seenFile: join(root, 'seen.jsonl') }
  if (!instance) {
    return {
      ...base,
      legacy: cairn,
      state: join(cairn, 'state', 'default'),
      env: { CAIRN_BASE_URL: BASE, CAIRN_API_KEY: KEY },
    }
  }
  const legacy = join(cairn, 'instances', instance)
  await mkdir(legacy, { recursive: true })
  await writeFile(join(legacy, 'env'), `CAIRN_API_KEY_TEST=${KEY}\n`, { mode: 0o600 })
  await writeFile(join(cairn, 'instances.json'), JSON.stringify({
    version: 1,
    instances: { [instance]: { url: BASE } },
    unclassified: { mode: 'default', instance },
  }))
  return { ...base, legacy, state: join(cairn, 'state', instance), env: { CAIRN_INSTANCE: instance } }
}

type Ran = { code: number | null; stdout: string; stderr: string }

const cli = (w: World, args: string[], extra: Record<string, string> = {}): Promise<Ran> => {
  const env: Record<string, string | undefined> = { ...process.env }
  for (const name of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_|CODEX_|OPENCLAW_|CAIRN_)/.test(name)) delete env[name]
  Object.assign(env, {
    HOME: w.home,
    CAIRN_AGENT: 'test',
    SEEN_FILE: w.seenFile,
    FAKE_SERVER: 'up',
    ...w.env,
    ...extra,
  })
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', w.preload, join(process.cwd(), 'cli/cairn.mjs'), ...args], {
      env: env as NodeJS.ProcessEnv,
      cwd: w.root,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString() })
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString() })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin.end('')
  })
}

/** The server refuses every connection and a write is put aside at once rather than retried. */
const DOWN = { FAKE_SERVER: 'down', CAIRN_DEADLINE_MS: '-1' }

type Seen = { method: string; url: string; key: string | null; body: string }
const seenOf = async (w: World): Promise<Seen[]> =>
  (await readFile(w.seenFile, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as Seen)
const sentIds = async (w: World) => (await seenOf(w)).filter((s) => s.method === 'POST' && s.key).map((s) => s.key)

const entry = (id: string, at = new Date().toISOString()) => JSON.stringify({
  id,
  t: at,
  method: 'POST',
  path: '/api/v1/tasks/CAIRN-1/notes',
  body: { note: id, kind: 'note' },
  agent: 'test',
  base: BASE,
  keyId: KEY_ID,
})

const linesOf = async (path: string) => (await readFile(path, 'utf8').catch(() => '')).split('\n').filter(Boolean)
const idsOf = async (path: string) => (await linesOf(path)).map((l) => (JSON.parse(l) as { id: string }).id)
const names = async (dir: string) => (await readdir(dir).catch(() => [] as string[])).sort()
const mode = async (path: string) => (await stat(path)).mode & 0o777

/** Every entry waiting in a directory's queue files, whichever stage of a replay left them there. */
const queuedIds = async (dir: string) => {
  const ids: string[] = []
  for (const name of await names(dir)) {
    const queue = name === 'outbox.jsonl' || /^outbox\.jsonl\.(pending|processing)-/.test(name)
    if (queue && !name.endsWith('.tmp')) ids.push(...(await idsOf(join(dir, name))))
  }
  return ids
}

const walk = async (dir: string): Promise<string[]> => {
  const out: string[] = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, e.name)
    if (e.isDirectory()) out.push(`${relative(dir, full)}/`, ...(await walk(full)).map((p) => join(e.name, p)))
    else out.push(relative(dir, full))
  }
  return out.sort()
}

/** The agent's view: ~/.cairn and the instance directory read-only, the state directory writable. */
const restrict = async (w: World) => {
  await mkdir(w.state, { recursive: true, mode: 0o700 })
  for (const dir of [w.legacy, w.cairn]) {
    restore.push(dir)
    await chmod(dir, 0o500)
  }
}

describe('mutable state outside ~/.cairn and the instance directory', () => {
  it.skipIf(!canRestrict)('AC1: spawned by an agent that can write only the state directory, notes and checkpoints queue with the server down and replay later; claim and close fail plainly, never with EPERM', async () => {
    const w = await world({ instance: 'work' })
    await mkdir(join(w.legacy, 'ownership'), { recursive: true })
    await writeFile(join(w.legacy, 'ownership', 'CAIRN-1.json'), JSON.stringify({ ownershipVersion: 4, checkpointVersion: 0 }))
    await restrict(w)

    const note = await cli(w, ['note', 'CAIRN-1', 'queued while down'], DOWN)
    const checkpoint = await cli(w, ['checkpoint', 'CAIRN-1', '--summary', 'halfway'], DOWN)
    for (const ran of [note, checkpoint]) {
      expect(ran.stderr).toContain('queued locally')
      expect(ran.stderr).not.toMatch(/EPERM|EACCES/)
      expect(ran.code).toBe(0)
    }
    for (const verb of [['claim', 'CAIRN-1'], ['done', 'CAIRN-1', '--resolution', 'fixed', '--kind', 'fixed']]) {
      const failed = await cli(w, verb, DOWN)
      expect(failed.code).not.toBe(0)
      expect(failed.stderr).toContain('cannot reach')
      expect(failed.stderr).not.toMatch(/EPERM|EACCES/)
    }
    const queued = await linesOf(join(w.state, 'outbox.jsonl'))
    expect(queued.map((l) => (JSON.parse(l) as { path: string }).path)).toEqual([
      '/api/v1/tasks/CAIRN-1/notes',
      '/api/v1/tasks/CAIRN-1/checkpoint',
    ])
    expect(await names(w.legacy)).toEqual(['env', 'ownership'])

    const replayed = await cli(w, ['replay'])
    expect(replayed.code).toBe(0)
    expect(replayed.stdout).toContain('sent 2')
    expect(await sentIds(w)).toHaveLength(2)
    expect(await linesOf(join(w.state, 'outbox.jsonl'))).toEqual([])
  })

  it('AC2: spawned with CAIRN_STATE_DIR set, every state write lands under that directory and nowhere else', async () => {
    const w = await world()
    const custom = join(w.root, 'custom-state')
    const before = await walk(w.home)
    await cli(w, ['note', 'CAIRN-1', 'sent'], { CAIRN_STATE_DIR: custom })
    await cli(w, ['note', 'CAIRN-1', 'queued'], { ...DOWN, CAIRN_STATE_DIR: custom })
    expect(await walk(w.home)).toEqual(before)
    expect(await names(custom)).toEqual(['acted.jsonl', 'outbox.jsonl'])
  })

  it('AC3: spawned with queued writes and an acted log, the state directory holds no env or credential file and no key', async () => {
    const w = await world({ instance: 'work' })
    await cli(w, ['note', 'CAIRN-1', 'sent'])
    await cli(w, ['note', 'CAIRN-1', 'queued'], DOWN)
    const files = (await walk(w.state)).filter((p) => !p.endsWith('/'))
    expect(files.length).toBeGreaterThan(1)
    expect(files.filter((p) => /(^|\/)env$|credential|secret|\.key$/i.test(p))).toEqual([])
    for (const file of files) expect(await readFile(join(w.state, file), 'utf8')).not.toContain(KEY)
    expect(await names(w.legacy)).toEqual(['env'])
  })

  it('AC4: spawned as six agents queueing at once with the server down, they serialise on the lock and no entry is lost', async () => {
    const w = await world()
    await Promise.all(Array.from({ length: 6 }, (_, i) => cli(w, ['note', 'CAIRN-1', `agent ${i}`], DOWN)))
    const ids = await idsOf(join(w.state, 'outbox.jsonl'))
    expect(ids).toHaveLength(6)
    expect(new Set(ids).size).toBe(6)
    const notes = (await linesOf(join(w.state, 'outbox.jsonl'))).map((l) => (JSON.parse(l) as { body: { note: string } }).body.note)
    expect(notes.sort()).toEqual(Array.from({ length: 6 }, (_, i) => `agent ${i}`))
    expect(await names(w.state)).not.toContain('outbox.jsonl.lock')
  })

  it('AC5: spawned over entries queued by an older CLI in the old location, replay sends each exactly once', async () => {
    const w = await world()
    await writeFile(join(w.legacy, 'outbox.jsonl'), `${entry('old-1')}\n${entry('old-2')}\n`)
    await writeFile(join(w.legacy, 'outbox.jsonl.pending-aaa'), `${entry('old-3')}\n`)
    const first = await cli(w, ['replay'])
    expect(first.stdout).toContain('sent 3')
    expect((await sentIds(w)).sort()).toEqual(['old-1', 'old-2', 'old-3'])
    expect((await names(w.legacy)).filter((n) => n.startsWith('outbox.jsonl'))).toEqual([])
    await cli(w, ['replay'])
    expect((await sentIds(w)).sort()).toEqual(['old-1', 'old-2', 'old-3'])
  })

  it('AC6: spawned after migration with an older CLI appending to the old outbox again, late appends are sent and nothing is sent twice', async () => {
    const w = await world()
    await writeFile(join(w.legacy, 'outbox.jsonl'), `${entry('early')}\n`)
    await cli(w, ['replay'])
    await writeFile(join(w.legacy, 'outbox.jsonl'), `${entry('late-1')}\n${entry('late-2')}\n`)
    const second = await cli(w, ['replay'])
    expect(second.stdout).toContain('sent 2')
    // A successful write also drains what an older CLI left behind.
    await writeFile(join(w.legacy, 'outbox.jsonl'), `${entry('late-3')}\n`)
    await cli(w, ['note', 'CAIRN-1', 'live'])
    const ids = (await sentIds(w)).filter((k) => k !== null)
    expect(ids.filter((k) => k !== null && k.startsWith('late') || k === 'early').sort()).toEqual(['early', 'late-1', 'late-2', 'late-3'])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('AC7: spawned as two new CLIs migrating at once with the server down, each old entry is queued once', async () => {
    const w = await world()
    const old = ['m-1', 'm-2', 'm-3', 'm-4']
    await writeFile(join(w.legacy, 'outbox.jsonl'), `${old.map((id) => entry(id)).join('\n')}\n`)
    await writeFile(join(w.legacy, 'outbox.jsonl.pending-bbb'), `${entry('m-5')}\n`)
    await Promise.all([
      cli(w, ['note', 'CAIRN-1', 'first'], DOWN),
      cli(w, ['note', 'CAIRN-1', 'second'], DOWN),
      cli(w, ['replay'], DOWN),
    ])
    const queued = await queuedIds(w.state)
    const migrated = queued.filter((id) => id.startsWith('m-'))
    expect(migrated.sort()).toEqual(['m-1', 'm-2', 'm-3', 'm-4', 'm-5'])
    expect(queued).toHaveLength(7)
    expect((await names(w.legacy)).filter((n) => n.startsWith('outbox.jsonl'))).toEqual([])
  })

  it.skipIf(!canRestrict)('AC8: spawned over a read-only old directory, replay sends the old entries once and records them in the state directory', async () => {
    const w = await world()
    await writeFile(join(w.legacy, 'outbox.jsonl'), `${entry('ro-1')}\n${entry('ro-2')}\n`)
    await restrict(w)
    const first = await cli(w, ['replay'])
    expect(first.code).toBe(0)
    expect(first.stdout).toContain('sent 2')
    expect((await sentIds(w)).sort()).toEqual(['ro-1', 'ro-2'])
    const record = await readFile(join(w.state, 'outbox.legacy-seen'), 'utf8')
    expect(record).toContain('ro-1')
    expect(record).toContain('ro-2')
    expect(await idsOf(join(w.legacy, 'outbox.jsonl'))).toEqual(['ro-1', 'ro-2'])

    await cli(w, ['replay'])
    await cli(w, ['note', 'CAIRN-1', 'live'])
    expect((await sentIds(w)).filter((k) => k?.startsWith('ro-')).sort()).toEqual(['ro-1', 'ro-2'])

    // An older CLI that can still write appends later: only the new entry goes.
    await chmod(w.cairn, 0o700)
    await writeFile(join(w.legacy, 'outbox.jsonl'), `${entry('ro-1')}\n${entry('ro-2')}\n${entry('ro-3')}\n`)
    await chmod(w.cairn, 0o500)
    await cli(w, ['replay'])
    expect((await sentIds(w)).filter((k) => k?.startsWith('ro-')).sort()).toEqual(['ro-1', 'ro-2', 'ro-3'])

    // And once a CLI that can change the old directory takes it over, ids already sent are still not sent again.
    await chmod(w.cairn, 0o700)
    await writeFile(join(w.legacy, 'outbox.jsonl'), `${entry('ro-2')}\n${entry('ro-4')}\n`)
    await cli(w, ['replay'])
    expect((await sentIds(w)).filter((k) => k?.startsWith('ro-')).sort()).toEqual(['ro-1', 'ro-2', 'ro-3', 'ro-4'])
    expect((await names(w.legacy)).filter((n) => n.startsWith('outbox.jsonl'))).toEqual([])
  })

  it('AC9: spawned over pending, processing, ack, rejected and stale lock files, live processing files stay, acks travel and locks are not copied', async () => {
    const w = await world()
    const dead = spawnSync(process.execPath, ['-e', '0']).pid
    const live = `outbox.jsonl.processing-${process.pid}-live`
    const gone = `outbox.jsonl.processing-${dead}-gone`
    await writeFile(join(w.legacy, 'outbox.jsonl.pending-p1'), `${entry('pend-1')}\n`)
    await writeFile(join(w.legacy, live), `${entry('live-1')}\n`)
    await writeFile(join(w.legacy, gone), `${entry('dead-1')}\n`)
    const ack = { path: '/api/v1/tasks/CAIRN-1/checkpoint', data: { ownership_version: 4, checkpoint_version: 2 } }
    await writeFile(join(w.legacy, 'outbox.jsonl.ack-a1.json'), `${JSON.stringify(ack)}\n`)
    await writeFile(join(w.legacy, 'outbox.jsonl.rejected'), `${JSON.stringify({ reason: 'history' })}\n`)
    await writeFile(join(w.legacy, 'outbox.jsonl.replay.lock'), JSON.stringify({ pid: dead, token: 'x' }))
    await writeFile(join(w.legacy, 'outbox.jsonl.lock'), '')
    const long = new Date(Date.now() - 10 * 60_000)
    await utimes(join(w.legacy, 'outbox.jsonl.lock'), long, long)

    await cli(w, ['note', 'CAIRN-1', 'trigger'], DOWN)

    const left = (await names(w.legacy)).filter((n) => n.startsWith('outbox.jsonl'))
    expect(left).toEqual([live, 'outbox.jsonl.rejected', 'outbox.jsonl.replay.lock'].sort())
    const inState = await names(w.state)
    expect(inState).toContain('outbox.jsonl.ack-a1.json')
    expect(inState).not.toContain('outbox.jsonl.replay.lock')
    expect(inState).not.toContain('outbox.jsonl.rejected')
    const queued = await queuedIds(w.state)
    expect(queued.filter((id) => id.endsWith('-1')).sort()).toEqual(['dead-1', 'pend-1'])
    expect(queued).not.toContain('live-1')
    expect(await readFile(join(w.legacy, 'outbox.jsonl.rejected'), 'utf8')).toContain('history')
  })

  it('AC10: spawned with no state directory, it is created 0700 with 0600 files, and a relative CAIRN_STATE_DIR is refused', async () => {
    const w = await world()
    await cli(w, ['note', 'CAIRN-1', 'sent'])
    await cli(w, ['note', 'CAIRN-1', 'queued'], DOWN)
    expect(await mode(join(w.cairn, 'state'))).toBe(0o700)
    expect(await mode(w.state)).toBe(0o700)
    for (const file of ['outbox.jsonl', 'acted.jsonl']) expect(await mode(join(w.state, file))).toBe(0o600)

    const custom = join(w.root, 'a', 'b', 'state')
    await cli(w, ['note', 'CAIRN-1', 'queued'], { ...DOWN, CAIRN_STATE_DIR: custom })
    expect(await mode(custom)).toBe(0o700)
    expect(await mode(join(custom, 'outbox.jsonl'))).toBe(0o600)

    const fresh = await world()
    const refused = await cli(fresh, ['note', 'CAIRN-1', 'x'], { ...DOWN, CAIRN_STATE_DIR: 'relative/state' })
    expect(refused.code).toBe(2)
    expect(refused.stderr).toMatch(/CAIRN_STATE_DIR must be an absolute path/)
    expect(await names(fresh.cairn)).toEqual([])
    expect(await names(fresh.root)).not.toContain('relative')
  })

  it('AC11: spawned with project-keys.json only in the old location, the old file is used and the refresh writes only under the state directory', async () => {
    const w = await world({ instance: 'work' })
    const legacyFile = join(w.legacy, 'project-keys.json')
    const stale = new Date(Date.now() - 7 * 60 * 60_000)
    const old = JSON.stringify({ at: stale.toISOString(), keys: ['OLD'] })
    await writeFile(legacyFile, old)
    await utimes(legacyFile, stale, stale)

    // Fresh enough, the old file answers and nothing is written.
    const fresh = JSON.stringify({ at: new Date().toISOString(), keys: ['OLD'] })
    await writeFile(legacyFile, fresh)
    await cli(w, ['note', 'CAIRN-1', 'one'])
    expect(await names(w.state)).not.toContain('project-keys.json')
    expect((await seenOf(w)).some((s) => s.url.endsWith('/api/v1/projects'))).toBe(false)

    // Stale, the refresh asks the server and writes the new file, leaving the old one alone.
    await writeFile(legacyFile, old)
    await utimes(legacyFile, stale, stale)
    await cli(w, ['note', 'CAIRN-1', 'two'])
    expect(JSON.parse(await readFile(join(w.state, 'project-keys.json'), 'utf8')).keys).toEqual(['WORK'])
    expect(await readFile(legacyFile, 'utf8')).toBe(old)
    expect(await mode(join(w.state, 'project-keys.json'))).toBe(0o600)
  })

  it.skipIf(!canRestrict)('AC12: spawned with only the state directory writable, no cache or acted-log write makes a verb fail', async () => {
    const w = await world({ instance: 'work' })
    const stale = new Date(Date.now() - 7 * 60 * 60_000)
    await writeFile(join(w.legacy, 'project-keys.json'), JSON.stringify({ at: stale.toISOString(), keys: ['OLD'] }))
    await utimes(join(w.legacy, 'project-keys.json'), stale, stale)
    await writeFile(join(w.legacy, 'lab.json'), JSON.stringify({ enabled: false }))
    await restrict(w)
    for (const args of [['note', 'CAIRN-1', 'hello'], ['context'], ['show', 'CAIRN-1']]) {
      const ran = await cli(w, args)
      expect(ran.code, `${args.join(' ')}: ${ran.stderr}`).toBe(0)
      expect(ran.stderr).not.toMatch(/EPERM|EACCES/)
    }
    expect(await names(w.state)).toEqual(expect.arrayContaining(['acted.jsonl', 'project-keys.json']))
    expect(await names(w.legacy)).toEqual(['lab.json', 'env', 'project-keys.json'].sort())

    // A cache that cannot be written at all is still only a hint.
    await chmod(w.state, 0o500)
    restore.push(w.state)
    const readOnly = await cli(w, ['note', 'CAIRN-1', 'again'])
    expect(readOnly.code).toBe(0)
  })
})

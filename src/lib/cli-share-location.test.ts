import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * CAIRN_SHARE_LOCATION=off keeps a machine's layout on the machine: no working
 * directory, no git remote, no hostname in any request.
 *
 * The CLI is a script, so each case spawns it (that is why the titles say
 * "spawned"). Nothing else is real: `fetch` is replaced by a preload that
 * records every request to a file and answers locally, and `git` is a fake
 * on PATH that names a checkout and an origin, so no server, network or
 * repository is involved.
 */

const ORIGIN = 'git@github.com:acme/secret-client-repo.git'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

type Seen = { url: string; method: string; headers: Record<string, string>; body: string }

const PRELOAD = `
import { appendFileSync } from 'node:fs'
globalThis.fetch = async (url, init = {}) => {
  const headers = Object.fromEntries(new Headers(init.headers ?? {}).entries())
  appendFileSync(process.env.SEEN_FILE, JSON.stringify({ url: String(url), method: init.method ?? 'GET', headers, body: String(init.body ?? '') }) + '\\n')
  const connect = String(url).includes('/api/v1/connect')
  const body = connect ? { success: false, error: 'test' } : { success: true, data: { key: 'CAIRN', project: 'CAIRN', id: 'x' } }
  return new Response(JSON.stringify(body), { status: connect ? 500 : 200, headers: { 'content-type': 'application/json' } })
}
`

const FAKE_GIT = `#!/bin/sh
case "$*" in
  *"rev-parse --show-toplevel"*) echo "$FAKE_TOP" ;;
  *"remote get-url origin"*) echo "$FAKE_ORIGIN" ;;
  *) exit 1 ;;
esac
`

type World = { home: string; checkout: string; seenFile: string; preload: string; bin: string; envFile: string }

const world = async (): Promise<World> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cairn-location-')))
  directories.push(root)
  const home = join(root, 'home')
  const checkout = join(root, 'home', 'clients', 'acme-secret')
  const bin = join(root, 'bin')
  await mkdir(checkout, { recursive: true })
  await mkdir(bin, { recursive: true })
  await mkdir(join(home, '.cairn'), { recursive: true })
  await writeFile(join(bin, 'git'), FAKE_GIT)
  await chmod(join(bin, 'git'), 0o755)
  const preload = join(root, 'preload.mjs')
  await writeFile(preload, PRELOAD)
  return { home, checkout, seenFile: join(root, 'seen.jsonl'), preload, bin, envFile: join(home, '.cairn', 'env') }
}

const run = async (w: World, args: string[], extra: Record<string, string> = {}, stdin = '') => {
  const env: Record<string, string | undefined> = { ...process.env }
  for (const name of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_|CODEX_|OPENCLAW_|CAIRN_)/.test(name)) delete env[name]
  Object.assign(env, {
    HOME: w.home,
    PATH: `${w.bin}:${process.env.PATH}`,
    CAIRN_BASE_URL: 'http://cairn.invalid',
    CAIRN_API_KEY: 'test-key',
    CAIRN_AGENT: 'test',
    SEEN_FILE: w.seenFile,
    FAKE_TOP: w.checkout,
    FAKE_ORIGIN: ORIGIN,
  }, extra)
  await new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', w.preload, join(process.cwd(), 'cli/cairn.mjs'), ...args], {
      env: env as NodeJS.ProcessEnv,
      cwd: w.checkout,
    })
    child.on('error', reject)
    child.on('close', resolve)
    child.stdout.resume()
    child.stderr.resume()
    child.stdin.end(stdin)
  })
  return seenOf(w)
}

const seenOf = async (w: World): Promise<Seen[]> => {
  const raw = await readFile(w.seenFile, 'utf8').catch(() => '')
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Seen)
}

const params = (s: Seen) => new URL(s.url).searchParams
const to = (seen: Seen[], fragment: string) => seen.filter((s) => s.url.includes(fragment))
const OFF = { CAIRN_SHARE_LOCATION: 'off' }

const sessionEnd = (extra: string[] = []) => [
  'session', 'end', '--id', 'sess-1', '--request', 'fix the bug', '--files', '', ...extra,
]

describe('CAIRN_SHARE_LOCATION', () => {
  it('AC1: spawned with the switch off in the environment, no request carries X-Cairn-Host', async () => {
    const w = await world()
    const seen = await run(w, ['context'], OFF)
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.filter((s) => 'x-cairn-host' in s.headers)).toEqual([])
  })

  it('AC2: spawned with the switch off in the env file, pairing sends the CAIRN_HOST label, or private-host', async () => {
    const w = await world()
    await writeFile(w.envFile, 'CAIRN_SHARE_LOCATION=off\n')
    const pair = (extra: Record<string, string>) =>
      run(w, ['setup', '--url', 'http://cairn.invalid', '--runtimes', 'claude-code', '--no-hooks', '--no-jobs', '--no-skill'], extra)
    const without = to(await pair({}), '/api/v1/connect')
    expect(JSON.parse(without[0]!.body).host).toBe('private-host')
    await rm(w.seenFile, { force: true })
    const labelled = await pair({ CAIRN_HOST: 'lab-mac' })
    expect(JSON.parse(to(labelled, '/api/v1/connect')[0]!.body).host).toBe('lab-mac')
    await run(w, ['context'], { CAIRN_HOST: 'lab-mac' })
    expect((await seenOf(w)).some((s) => s.headers['x-cairn-host'] === 'lab-mac')).toBe(true)
  })

  it('AC3: spawned in a checkout with the switch off, context sends no cwd and no repo, and a mapped project still resolves', async () => {
    const w = await world()
    await writeFile(join(w.home, '.cairn', 'projects.json'), JSON.stringify({ [w.checkout]: 'CAIRN' }))
    const [req] = to(await run(w, ['context'], OFF), '/api/v1/context')
    expect(params(req!).has('cwd')).toBe(false)
    expect(params(req!).has('repo')).toBe(false)
    expect(params(req!).get('project')).toBe('CAIRN')
  })

  it('AC4: spawned as the session-end hook calls it, the payload has no cwd and every file is repo-relative', async () => {
    const w = await world()
    const outside = join(w.home, 'elsewhere', 'notes.txt')
    const files = [join(w.checkout, 'src', 'a.ts'), 'src/b.ts', outside, '/etc/hosts'].join(',')
    const seen = await run(w, ['session', 'end', '--id', 'sess-1', '--cwd', w.checkout, '--files', files], OFF)
    const body = JSON.parse(to(seen, '/api/v1/sessions')[0]!.body)
    expect('cwd' in body).toBe(false)
    expect(body.files).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('AC6: spawned with the switch unset, cwd, repo and host are sent as before', async () => {
    const w = await world()
    const seen = await run(w, ['context'])
    const [req] = to(seen, '/api/v1/context')
    expect(params(req!).get('cwd')).toBe(w.checkout)
    expect(params(req!).get('repo')).toBe(ORIGIN)
    expect(req!.headers['x-cairn-host']).toBe(hostname().replace(/[^A-Za-z0-9._-]/g, ''))
    const ended = await run(w, ['session', 'end', '--id', 'sess-1', '--files', join(w.checkout, 'a.ts')])
    const body = JSON.parse(to(ended, '/api/v1/sessions')[0]!.body)
    expect(body.cwd).toBe(w.checkout)
    expect(body.repo).toBe(ORIGIN)
    expect(body.files).toEqual([join(w.checkout, 'a.ts')])
  })

  it('AC7: spawned with the switch off, session end and checkpoint carry no cwd or repo, and list --cwd and context --file send nothing absolute', async () => {
    const w = await world()
    const outside = join(w.home, 'elsewhere', 'x.txt')
    const ended = await run(w, ['session', 'end', '--id', 's', '--cwd', w.checkout], OFF)
    const checkpoint = await run(w, ['session', 'checkpoint', '--id', 's'], OFF)
    for (const s of to([...ended, ...checkpoint], '/api/v1/sessions').filter((r) => r.method === 'POST')) {
      const body = JSON.parse(s.body)
      expect('cwd' in body).toBe(false)
      expect('repo' in body).toBe(false)
    }
    await rm(w.seenFile, { force: true })
    const seen = await run(w, ['session', 'list', '--cwd', w.checkout], OFF)
    expect(params(to(seen, '/api/v1/sessions')[0]!).has('cwd')).toBe(false)
    await rm(w.seenFile, { force: true })
    const ctx = [
      ...(await run(w, ['context', '--file', outside], OFF)),
      ...(await run(w, ['context', '--file', join(w.checkout, 'src', 'a.ts')], OFF)),
    ]
    const sent = ctx.map((s) => params(s).get('file')).filter(Boolean)
    expect(sent).toEqual(['src/a.ts'])
    expect(ctx.some((s) => s.url.includes(w.home))).toBe(false)
  })

  it('AC8: spawned with the switch off, map sends no repo claim and still writes projects.json', async () => {
    const w = await world()
    const seen = await run(w, ['map', 'CAIRN', '--dir', w.checkout], OFF)
    expect(to(seen, '/repos')).toEqual([])
    expect(JSON.stringify(seen)).not.toContain(ORIGIN)
    const map = JSON.parse(await readFile(join(w.home, '.cairn', 'state', 'default', 'projects.json'), 'utf8'))
    expect(map[w.checkout]).toBe('CAIRN')
    await rm(w.seenFile, { force: true })
    const none = await run(w, ['map', 'none', '--dir', w.checkout], OFF)
    expect(to(none, '/repos').concat(none.filter((s) => s.method === 'DELETE'))).toEqual([])
    expect(JSON.parse(await readFile(join(w.home, '.cairn', 'state', 'default', 'projects.json'), 'utf8'))[w.checkout]).toBeUndefined()
  })

  it('AC10: spawned with the switch off, only paths under the git toplevel are kept, relative, and none when there is no toplevel', async () => {
    const w = await world()
    const link = join(w.home, 'link')
    const { symlink } = await import('node:fs/promises')
    await symlink(w.checkout, link)
    const files = [join(link, 'src', 'viaLink.ts'), join(w.checkout, 'a.ts'), '/tmp/other', join(w.home, 'x')].join(',')
    const body = JSON.parse(to(await run(w, ['session', 'end', '--id', 's', '--cwd', w.checkout, '--files', files], OFF), '/api/v1/sessions')[0]!.body)
    expect(body.files).toEqual(['src/viaLink.ts', 'a.ts'])
    await rm(w.seenFile, { force: true })
    const web = join(w.checkout, 'web')
    await mkdir(web, { recursive: true })
    const sub = await run(w, ['session', 'end', '--id', 's', '--cwd', web, '--files', 'a.ts,../../outside.txt,../up.txt,/abs/elsewhere'], { ...OFF, FAKE_TOP: w.checkout })
    // ../up.txt is still inside the repository (root-relative up.txt); ../../outside.txt is not.
    expect(JSON.parse(to(sub, '/api/v1/sessions')[0]!.body).files).toEqual(['web/a.ts', 'up.txt'])
    await rm(w.seenFile, { force: true })
    const none = await run(w, ['session', 'end', '--id', 's', '--cwd', w.checkout, '--files', join(w.checkout, 'a.ts')], { ...OFF, FAKE_TOP: '' })
    expect(JSON.parse(to(none, '/api/v1/sessions')[0]!.body).files).toEqual([])
  })

  it('AC11: spawned with the switch off, summaries have the repo root, home and hostname replaced', async () => {
    const w = await world()
    const host = hostname()
    const text = `edited ${w.checkout}/src/a.ts and ${w.home}/notes on ${host}`
    const seen = await run(w, ['session', 'end', '--id', 's', '--cwd', w.checkout, '--request', text, '--learned', text, '--completed', text, '--next', text], OFF)
    const body = JSON.parse(to(seen, '/api/v1/sessions')[0]!.body)
    const expected = `edited <repo>/src/a.ts and ~/notes on private-host`
    for (const field of ['request', 'learned', 'completed', 'nextSteps']) expect(body[field]).toBe(expected)
  })

  it('AC12: spawned with values of the switch, only off/0/false/no turn it off, and the environment wins over the file', async () => {
    const w = await world()
    const sends = async (extra: Record<string, string>) => {
      await rm(w.seenFile, { force: true })
      const [req] = to(await run(w, ['context'], extra), '/api/v1/context')
      return params(req!).has('cwd')
    }
    for (const off of ['off', ' OFF ', '0', 'false', 'No']) expect(await sends({ CAIRN_SHARE_LOCATION: off })).toBe(false)
    for (const on of ['', 'on', 'maybe', '1']) expect(await sends({ CAIRN_SHARE_LOCATION: on })).toBe(true)
    await writeFile(w.envFile, 'CAIRN_SHARE_LOCATION=off\n')
    expect(await sends({})).toBe(false)
    expect(await sends({ CAIRN_SHARE_LOCATION: 'on' })).toBe(true)
  })

  it('AC13: spawned with the switch off, the acted log stays local and keeps the real directory', async () => {
    const w = await world()
    const seen = await run(w, ['note', 'CAIRN-1', 'hello'], OFF)
    expect(JSON.stringify(seen)).not.toContain(w.checkout)
    const acted = await readFile(join(w.home, '.cairn', 'state', 'default', 'acted.jsonl'), 'utf8').catch(() => '')
    expect(acted).toContain(w.checkout)
  })

  it('AC14: spawned with the switch off, no request across context, session end, pair, map, add and note carries hostname, cwd, origin or home', async () => {
    const w = await world()
    const all: Seen[] = []
    const go = async (args: string[], stdin = '') => { all.push(...(await run(w, args, OFF, stdin))); await rm(w.seenFile, { force: true }) }
    await go(['context'])
    await go(['session', 'end', '--id', 's', '--cwd', w.checkout, '--files', join(w.checkout, 'a.ts')])
    await go(['setup', '--url', 'http://cairn.invalid', '--runtimes', 'claude-code', '--no-hooks', '--no-jobs', '--no-skill'])
    await go(['map', 'CAIRN', '--dir', w.checkout])
    await go(['add', 'a task', '--project', 'CAIRN', '--body', 'body'])
    await go(['note', 'CAIRN-1', 'a note'])
    expect(all.length).toBeGreaterThan(5)
    const wire = JSON.stringify(all)
    for (const secret of [hostname(), w.checkout, w.home, ORIGIN, 'secret-client-repo']) {
      expect(wire, `leaked ${secret}`).not.toContain(secret)
    }
  })
})

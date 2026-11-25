import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { closeSync, openSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, spawnSync, type StdioOptions } from 'node:child_process'

/**
 * CAIRN-457: `--body -` with nothing on stdin used to wait forever. A terminal
 * is refused at once; a stream that says nothing within the wait is given up
 * on; a body that has started, a file and a heredoc are read as before.
 */
const CLI = resolve('cli/cairn.mjs')
const servers: Server[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))))
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

type Seen = { method?: string; raw: string }

const serve = (seen: Seen[]) =>
  new Promise<string>((done) => {
    const server = createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => {
        seen.push({ method: req.method, raw })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ success: true, data: { ref: 'CAIRN-1', number: 1, id: 'x' } }))
      })
    })
    servers.push(server)
    server.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${(server.address() as { port: number }).port}`))
  })

const home = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cairn-stdin-'))
  directories.push(dir)
  return dir
}

const envFor = (dir: string, base: string, wait: string) => ({
  ...process.env,
  HOME: dir,
  CAIRN_BASE_URL: base,
  CAIRN_API_KEY: 'test-key',
  CAIRN_AGENT: 'test',
  CAIRN_STDIN_TIMEOUT_MS: wait,
})

type Result = { code: number | null; stderr: string; ms: number }

/** Run `cairn note CAIRN-1 --body -`; `feed` drives the stdin pipe (or a fd/stdio is given). */
const run = (env: NodeJS.ProcessEnv, feed: ((stdin: NodeJS.WritableStream) => void) | StdioOptions) =>
  new Promise<Result>((done, fail) => {
    const started = Date.now()
    const stdio = typeof feed === 'function' ? 'pipe' : feed
    const child = spawn('node', [CLI, 'note', 'CAIRN-1', '--body', '-'], { env, stdio })
    let stderr = ''
    child.stderr?.on('data', (c: Buffer) => { stderr += c.toString() })
    child.on('error', fail)
    child.on('close', (code) => done({ code, stderr, ms: Date.now() - started }))
    if (typeof feed === 'function' && child.stdin) feed(child.stdin)
  })

/** Async: the fake server lives in this process, so a spawnSync would starve it. */
const runShell = (command: string, args: string[], env: NodeJS.ProcessEnv) =>
  new Promise<{ code: number | null; out: string; ms: number }>((done, fail) => {
    const started = Date.now()
    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (c: Buffer) => { out += c.toString() })
    child.stderr.on('data', (c: Buffer) => { out += c.toString() })
    child.on('error', fail)
    const kill = setTimeout(() => child.kill('SIGKILL'), 20000)
    child.on('close', (code) => {
      clearTimeout(kill)
      done({ code, out, ms: Date.now() - started })
    })
  })

const posted = (seen: Seen[]) => seen.filter((s) => s.method === 'POST').map((s) => s.raw).join('\n')

describe('reading a body from stdin (CAIRN-457)', () => {
  it('gives up on a pipe that stays silent, and writes nothing', async () => {
    const seen: Seen[] = []
    const base = await serve(seen)
    let pipe: NodeJS.WritableStream | undefined
    const result = await run(envFor(await home(), base, '300'), (stdin) => { pipe = stdin })
    pipe?.end()
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('no body on stdin: pipe or redirect it, or use a heredoc')
    expect(result.ms).toBeLessThan(8000)
    expect(posted(seen)).toBe('')
  })

  it('reads a body that has started to its end, however slowly the rest comes', async () => {
    const seen: Seen[] = []
    const base = await serve(seen)
    const result = await run(envFor(await home(), base, '400'), (stdin) => {
      setTimeout(() => stdin.write('first half, '), 100)
      setTimeout(() => stdin.end('second half'), 1000)
    })
    expect(result.code, result.stderr).toBe(0)
    expect(posted(seen)).toContain('first half, second half')
  })

  it('reads a redirected file as before, whatever the wait', async () => {
    const seen: Seen[] = []
    const base = await serve(seen)
    const dir = await home()
    const path = join(dir, 'body.md')
    await writeFile(path, 'from a file')
    const fd = openSync(path, 'r')
    try {
      const result = await run(envFor(dir, base, '1'), [fd, 'ignore', 'pipe'])
      expect(result.code, result.stderr).toBe(0)
    } finally {
      closeSync(fd)
    }
    expect(posted(seen)).toContain('from a file')
  })

  it('reads a heredoc as before', async () => {
    const seen: Seen[] = []
    const base = await serve(seen)
    const env = envFor(await home(), base, '2000')
    const shell = await runShell('bash', ['-c', `node '${CLI}' note CAIRN-1 --body - <<'EOF'\nfrom a heredoc\nEOF`], env)
    expect(shell.code, shell.out).toBe(0)
    expect(posted(seen)).toContain('from a heredoc')
  })

  /** Runs a command on a fresh pseudo-terminal, so its stdin is a TTY. */
  const PTY = [
    'import os, pty, sys',
    'pid, fd = pty.fork()',
    'if pid == 0:',
    '    os.execvp(sys.argv[1], sys.argv[1:])',
    'out = b""',
    'while True:',
    '    try:',
    '        chunk = os.read(fd, 1024)',
    '    except OSError:',
    '        break',
    '    if not chunk:',
    '        break',
    '    out += chunk',
    '_, status = os.waitpid(pid, 0)',
    'sys.stdout.write(out.decode(errors="replace"))',
    'sys.exit(os.waitstatus_to_exitcode(status))',
  ].join('\n')
  const hasPython = spawnSync('python3', ['-c', 'import pty']).status === 0

  it.skipIf(!hasPython)('refuses a terminal at once', async () => {
    const seen: Seen[] = []
    const base = await serve(seen)
    const env = envFor(await home(), base, '60000')
    const out = await runShell('python3', ['-c', PTY, 'node', CLI, 'note', 'CAIRN-1', '--body', '-'], env)
    expect(out.ms).toBeLessThan(15000)
    expect(out.code).not.toBe(0)
    expect(out.out).toContain('no body on stdin: pipe or redirect it, or use a heredoc')
    expect(posted(seen)).toBe('')
  })
})

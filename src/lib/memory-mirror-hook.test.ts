import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * CAIRN-458: a Claude memory file written without a `cairn learn` blocks with
 * the command that mirrors it, on the instance `cairn route` resolves.
 */
const HOOK = join(process.cwd(), 'hooks', 'cairn-memory-mirror.mjs')

let dir: string
let cli: string
let memoryDir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cairn-mirror-'))
  memoryDir = join(dir, '.claude', 'projects', '-srv-work-repo', 'memory')
  mkdirSync(memoryDir, { recursive: true })
  // A stand-in for `cairn route --json` that also says what it was asked.
  cli = join(dir, 'cairn')
  writeFileSync(
    cli,
    `#!/bin/sh\necho "$@" > "${dir}/route-args"\necho '{"path":"~/repo","instance":"personal","why":"default instance"}'\n`,
  )
  chmodSync(cli, 0o755)
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

type Result = { out: string; code: number | null }

const run = (payload: unknown, env: Record<string, string> = {}): Promise<Result> =>
  new Promise((done) => {
    const child = spawn('node', [HOOK], {
      env: { PATH: process.env.PATH ?? '', HOME: dir, CAIRN_CLI: cli, ...env } as unknown as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    let out = ''
    child.stdout.on('data', (d) => {
      out += d
    })
    child.on('close', (code) => done({ out, code }))
    child.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload))
  })

const reasonOf = ({ out }: Result) => {
  if (!out) return null
  const parsed = JSON.parse(out)
  return parsed.decision === 'block' ? String(parsed.reason) : null
}

const MEMORY = `---
name: deferred-fks-go-after-the-backfill
description: Deferred FKs go after the backfill, never before
metadata:
  type: project
---

Adding the FK first locks the table for the whole backfill.
`

const transcript = (rows: unknown[]) => {
  const path = join(dir, `t-${Math.random().toString(36).slice(2)}.jsonl`)
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n'))
  return path
}
const prompt = (text: string) => ({ type: 'user', message: { role: 'user', content: text } })
const tool = (name: string, input: Record<string, unknown>) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', name, input }] },
})

const writeMemory = (file: string, extra: Record<string, unknown> = {}) => ({
  hook_event_name: 'PostToolUse',
  session_id: 'b1d0c6a2-6f0e-4c55-9f1e-4b1c2a3d4e5f',
  cwd: '/srv/work/repo',
  tool_name: 'Write',
  tool_input: { file_path: join(memoryDir, file), content: MEMORY },
  ...extra,
})

describe('the memory-mirror hook', () => {
  it('blocks a memory write with the learn command, on the instance cairn route resolves', async () => {
    const result = await run(writeMemory('deferred-fks.md'))
    expect(result.code).toBe(0)
    const reason = reasonOf(result)
    expect(reason).toContain(join(memoryDir, 'deferred-fks.md'))
    expect(reason).toContain('`cairn --instance personal learn "Deferred FKs go after the backfill, never before" --project <KEY> --body -`')
    expect(reason).toContain('cairn --instance personal relearn deferred-fks-go-after-the-backfill --body -')
    expect(reason).toContain('Lab work alone goes to croft.')
    expect(readFileSync(join(dir, 'route-args'), 'utf8').trim()).toBe('route --json --cwd /srv/work/repo')
  })

  it('reads an edited memory from disk and offers relearn first', async () => {
    writeFileSync(join(memoryDir, 'deferred-fks.md'), MEMORY)
    const reason = reasonOf(
      await run(
        writeMemory('deferred-fks.md', {
          tool_name: 'Edit',
          tool_input: { file_path: join(memoryDir, 'deferred-fks.md'), old_string: 'a', new_string: 'b' },
        }),
      ),
    )
    expect(reason).toContain('this edits an existing memory')
    expect(reason).toContain('relearn deferred-fks-go-after-the-backfill')
  })

  it('stays silent for MEMORY.md and for any file that is not a memory', async () => {
    const at = (file_path: string) => writeMemory('x.md', { tool_input: { file_path, content: MEMORY } })
    expect((await run(at(join(memoryDir, 'MEMORY.md')))).out).toBe('')
    expect((await run(at(join(dir, '.claude', 'CLAUDE.md')))).out).toBe('')
    expect((await run(at(join(dir, '.claude', 'projects', '-srv-work-repo', 'notes.md')))).out).toBe('')
    expect((await run(at(join(memoryDir, 'data.json')))).out).toBe('')
    expect((await run(at('/srv/work/repo/docs/memory/lesson.md'))).out).toBe('')
  })

  it('finds memory under CLAUDE_CONFIG_DIR too', async () => {
    const config = join(dir, 'claude-config')
    const file_path = join(config, 'projects', 'p', 'memory', 'lesson.md')
    const result = await run(writeMemory('x.md', { tool_input: { file_path, content: MEMORY } }), { CLAUDE_CONFIG_DIR: config })
    expect(reasonOf(result)).toContain(file_path)
  })

  it('stays silent when this turn already ran cairn learn or relearn', async () => {
    const learned = transcript([
      prompt('Save that to memory'),
      tool('Bash', { command: 'cd /repo && cairn learn "Deferred FKs go after the backfill" --project CAIRN --body -' }),
    ])
    expect((await run(writeMemory('a.md', { transcript_path: learned }))).out).toBe('')

    const inCodeMode = transcript([
      prompt('Save that to memory'),
      tool('REPL', { code: 'await $`cairn --instance croft relearn deferred-fks --body -`.text()' }),
    ])
    expect((await run(writeMemory('a.md', { transcript_path: inCodeMode }))).out).toBe('')
  })

  it('still asks when the learn was in an earlier turn, or only its help was read', async () => {
    const earlier = transcript([
      prompt('Fix it'),
      tool('Bash', { command: 'cairn learn "Something else" --project CAIRN --body -' }),
      prompt('Now save the FK lesson to memory'),
    ])
    expect(reasonOf(await run(writeMemory('a.md', { transcript_path: earlier })))).not.toBeNull()

    const help = transcript([prompt('Save it'), tool('Bash', { command: 'cairn learn --help' })])
    expect(reasonOf(await run(writeMemory('a.md', { transcript_path: help })))).not.toBeNull()
  })

  it('is off with CAIRN_MEMORY_MIRROR=0 and inside summarisers', async () => {
    expect((await run(writeMemory('a.md'), { CAIRN_MEMORY_MIRROR: '0' })).out).toBe('')
    expect((await run(writeMemory('a.md'), { CAIRN_SUMMARISER: '1' })).out).toBe('')
    expect((await run(writeMemory('a.md'), { AGENT_MEMORY_SUMMARISER: '1' })).out).toBe('')
  })

  it('still asks, naming no instance, when cairn route cannot answer', async () => {
    const reason = reasonOf(await run(writeMemory('a.md'), { CAIRN_CLI: join(dir, 'no-such-cairn') }))
    expect(reason).toContain('on the instance `cairn route` resolves')
    expect(reason).toContain('`cairn learn "Deferred FKs go after the backfill, never before"')
  })

  it('stays silent, exit 0, on malformed or foreign input', async () => {
    for (const payload of ['', 'not json', '[]', 'null', { tool_name: 'Write' }, { tool_name: 'Write', tool_input: { file_path: 42 } }]) {
      const result = await run(payload)
      expect(result, JSON.stringify(payload)).toEqual({ out: '', code: 0 })
    }
    expect((await run(writeMemory('a.md', { tool_name: 'Read' }))).out).toBe('')
    expect((await run(writeMemory('a.md', { hook_event_name: 'PreToolUse' }))).out).toBe('')
  })
})

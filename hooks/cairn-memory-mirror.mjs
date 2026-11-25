#!/usr/bin/env node
/**
 * Mirrors Claude Code's file memory into Cairn (CAIRN-458).
 *
 * Memory means Cairn too: a lesson written to Claude Code's own memory
 * (~/.claude/projects/<project>/memory/<name>.md) reaches only the next Claude
 * session in that one directory, while `cairn learn` reaches every agent. The
 * learn nudge (Stop) does not cover it: it asks once per session and stays
 * silent for a session that already learned once, so memory written late in
 * such a session went unmirrored.
 *
 * So this runs on PostToolUse for Write|Edit|MultiEdit, the moment a memory
 * file is written, and blocks with the command that mirrors it, on the
 * instance `cairn route` resolves for the session's directory. A PostToolUse
 * block cannot undo the write; it hands the reason to the agent as feedback.
 *
 *   - only a memory file: MEMORY.md is the index, not a fact;
 *   - never when this turn already ran `cairn learn` or `relearn`;
 *   - never inside a summariser or with CAIRN_MEMORY_MIRROR=0.
 *
 * Silent on every failure: a memory prompt must never break a write.
 */
import { spawn } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

const SUMMARISER_FLAGS = ['CAIRN_SUMMARISER', 'QUARRY_SUMMARISER', 'AGENT_MEMORY_SUMMARISER']
const CLI = process.env.CAIRN_CLI ?? 'cairn'
const ROUTE_TIMEOUT_MS = 4000

/** Enough to hold the turn in progress; a long session's head is not needed. */
const TAIL_BYTES = 512 * 1024

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit'])

/**
 * Run as a command of its own, not quoted by grep or asked for its help. A
 * Code Mode script runs it inside a template literal, hence the backtick, and
 * `--instance <name>` may come before the verb.
 */
const LEARNED =
  /(?:^|[\n;&|(`]\s*)(?:\w+=\S*\s+)*cairn(?:\s+--instance(?:=|\s+)\S+)?\s+(?:re)?learn\s+(?!-h\b|--help\b)\S/

const readStdin = async () => {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  return raw ? JSON.parse(raw) : {}
}

const claudeDirs = () => [
  ...new Set([process.env.CLAUDE_CONFIG_DIR?.trim(), join(homedir(), '.claude')].filter(Boolean).map((d) => resolve(d))),
]

/**
 * Whether a path is one of Claude Code's memory files: a markdown file under
 * <config>/projects/<project>/memory/, other than the MEMORY.md index.
 * Recognised under the configured directory, or any `.claude` one: the hook may
 * run with a HOME that is not the session's.
 */
export const isMemoryFile = (path) => {
  if (typeof path !== 'string' || !path.endsWith('.md')) return false
  const full = resolve(path)
  if (basename(full) === 'MEMORY.md') return false
  const under = claudeDirs().some((dir) => full.startsWith(`${dir}/projects/`))
  const memory = /\/projects\/[^/]+\/memory\/(?:[^/]+\/)*[^/]+\.md$/.test(full)
  return memory && (under || /\/\.claude\/projects\//.test(full))
}

/** The `name:` and `description:` a memory file's frontmatter gives, if any. */
export const frontmatter = (text) => {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text ?? ''))?.[1] ?? ''
  const field = (key) => {
    const value = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(block)?.[1]?.trim()
    return value ? value.replace(/^(['"])(.*)\1$/, '$2') : undefined
  }
  return { name: field('name'), description: field('description') }
}

const readTail = (path) => {
  const size = statSync(path).size
  const start = Math.max(0, size - TAIL_BYTES)
  const buffer = Buffer.alloc(size - start)
  const fd = openSync(path, 'r')
  try {
    readSync(fd, buffer, 0, buffer.length, start)
  } finally {
    closeSync(fd)
  }
  const text = buffer.toString('utf8')
  return start === 0 ? text : text.slice(text.indexOf('\n') + 1)
}

const parseRows = (text) => {
  const rows = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      rows.push(JSON.parse(line))
    } catch {
      // a torn line
    }
  }
  return rows
}

/** A person's prompt — the start of a turn. */
const isPrompt = (row) => {
  if (row?.type !== 'user' || row.isMeta) return false
  const content = row.message?.content
  if (typeof content === 'string') return content.trim().length > 0
  return Array.isArray(content) && content.some((c) => c?.type === 'text')
}

/** The shell commands (and Code Mode scripts) one transcript row ran. */
const commandsOf = (row) =>
  (Array.isArray(row?.message?.content) ? row.message.content : [])
    .filter((c) => c?.type === 'tool_use')
    .flatMap((c) => [c.input?.command, c.input?.code])
    .filter((s) => typeof s === 'string')

/** Whether the turn in progress already ran `cairn learn` or `cairn relearn`. */
export const learnedThisTurn = (text) => {
  const rows = parseRows(text)
  let from = rows.length - 1
  while (from >= 0 && !isPrompt(rows[from])) from--
  return rows.slice(from + 1).flatMap(commandsOf).some((command) => LEARNED.test(command))
}

/** The instance `cairn route` names for the session's directory, or null. */
const routeInstance = (cwd, sessionId) =>
  new Promise((done) => {
    let out = ''
    let child
    try {
      child = spawn(CLI, ['route', '--json', ...(cwd ? ['--cwd', cwd] : [])], {
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, ...(sessionId ? { CLAUDE_CODE_SESSION_ID: sessionId } : {}) },
      })
    } catch {
      return done(null)
    }
    const timer = setTimeout(() => {
      child.kill()
      done(null)
    }, ROUTE_TIMEOUT_MS)
    child.stdout.on('data', (d) => {
      out += d
    })
    child.on('error', () => {
      clearTimeout(timer)
      done(null)
    })
    child.on('close', () => {
      clearTimeout(timer)
      try {
        const instance = JSON.parse(out)?.instance
        done(typeof instance === 'string' && /^[\w.-]+$/.test(instance) ? instance : null)
      } catch {
        done(null)
      }
    })
  })

const quoted = (s) => JSON.stringify(String(s).replace(/\s+/g, ' ').trim())

export const reasonFor = ({ path, name, description, instance, edited }) => {
  const cli = instance ? `cairn --instance ${instance}` : 'cairn'
  const title = description ?? name ?? '<title>'
  const slug = name ?? '<slug>'
  const where = instance
    ? `on ${instance} (what \`cairn route\` resolves for this session's directory)`
    : "on the instance `cairn route` resolves for this session's directory"
  const learn = `\`${cli} learn ${quoted(title)} --project <KEY> --body -\``
  const relearn = `\`${cli} relearn ${slug} --body -\``
  const already = edited
    ? `; this edits an existing memory, so if the lesson is already in Cairn correct it with ${relearn}`
    : `, or ${relearn} if it is already there`
  return [
    `You wrote Claude memory at ${path}. Memory means Cairn too: mirror this lesson ${where},`,
    `with the same body on stdin: ${learn}${already} (\`${cli} know ${quoted(title)}\` finds it).`,
    ...(instance === 'croft' ? [] : ['Lab work alone goes to croft.']),
    'If this write records no lesson (a wording fix, a pointer only), say so in one line and go on.',
  ].join(' ')
}

const main = async () => {
  if (process.env.CAIRN_MEMORY_MIRROR === '0') return
  if (SUMMARISER_FLAGS.some((name) => process.env[name] === '1')) return

  const payload = await readStdin()
  if (payload?.hook_event_name && payload.hook_event_name !== 'PostToolUse') return
  if (!EDIT_TOOLS.has(payload?.tool_name)) return
  const path = payload.tool_input?.file_path
  if (!isMemoryFile(path)) return

  const transcript = payload.transcript_path
  if (typeof transcript === 'string' && existsSync(transcript) && learnedThisTurn(readTail(transcript))) return

  const written =
    payload.tool_name === 'Write' && typeof payload.tool_input?.content === 'string'
      ? payload.tool_input.content
      : existsSync(path)
        ? readFileSync(path, 'utf8')
        : ''
  const { name, description } = frontmatter(written)
  const instance = await routeInstance(typeof payload.cwd === 'string' ? payload.cwd : undefined, payload.session_id)
  const reason = reasonFor({ path, name, description, instance, edited: payload.tool_name !== 'Write' })
  process.stdout.write(JSON.stringify({ decision: 'block', reason }))
}

if (import.meta.main ?? process.argv[1] === import.meta.filename) {
  main().catch((error) => {
    if (process.env.CAIRN_HOOK_DEBUG === '1') console.error('[cairn-memory-mirror]', error)
  })
}

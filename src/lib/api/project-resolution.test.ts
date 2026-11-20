import { describe, expect, it, vi } from 'vitest'

const touched: string[] = []
vi.mock('@/lib/db/client', () => ({
  admin: () => {
    touched.push('admin')
    throw new Error('the database must not be read without a cwd')
  },
}))
import { checkoutName, projectKeyForCheckoutName, repoName } from './project-resolution'

/** Absolute fixture paths, built so no real home directory is spelled out. */
const p = (...parts: string[]) => ['', ...parts].join('/')

/**
 * The server's last resort for a session that arrives with neither a project
 * nor a remote (CAIRN-286). It is inference, so the ambiguity rule is the part
 * worth pinning: one project answers, or none does.
 */
describe('attributing a session by its checkout name', () => {
  const rows = [
    { remote: 'github.com/montytorr/cairn', project: { key: 'CAIRN' } },
    { remote: 'github.com/montytorr/hermes', project: [{ key: 'HERMES' }] },
    { remote: 'github.com/a/api', project: { key: 'AAPI' } },
    { remote: 'github.com/b/api', project: { key: 'BAPI' } },
  ]

  it('reads the directory a checkout was cloned into', () => {
    expect(checkoutName(p('home', 'dev', 'cairn'))).toBe('cairn')
    expect(checkoutName(`${p('srv', 'projects', 'cairn')}/`)).toBe('cairn')
    expect(checkoutName(p('Users', 'dev', 'Hermes'))).toBe('hermes')
  })

  it('treats a worktree as its parent checkout', () => {
    expect(checkoutName(p('Users', 'dev', 'code', 'cairn', '.claude', 'worktrees', 'agent-a1'))).toBe('cairn')
    expect(checkoutName(p('Users', 'dev', 'cairn', '.worktrees', 'fix-x'))).toBe('cairn')
  })

  it('names a repository by the last segment of its remote, however it is spelled', () => {
    expect(repoName('git@github.com:montytorr/cairn.git')).toBe('cairn')
    expect(repoName('https://github.com/montytorr/Cairn/')).toBe('cairn')
  })

  it('answers when exactly one project has a repository by that name', () => {
    expect(projectKeyForCheckoutName(rows, 'cairn')).toBe('CAIRN')
    expect(projectKeyForCheckoutName(rows, 'hermes')).toBe('HERMES')
  })

  it('refuses to guess between two projects', () => {
    expect(projectKeyForCheckoutName(rows, 'api')).toBeNull()
  })

  it('answers once when one project lists the same name twice', () => {
    const twice = [...rows, { remote: 'gitlab.com/mirror/cairn', project: { key: 'CAIRN' } }]
    expect(projectKeyForCheckoutName(twice, 'cairn')).toBe('CAIRN')
  })

  it('answers nothing for a directory no repository is named after', () => {
    expect(projectKeyForCheckoutName(rows, 'dev')).toBeNull()
    expect(projectKeyForCheckoutName(rows, null)).toBeNull()
  })
})

/**
 * A client with CAIRN_SHARE_LOCATION=off sends no cwd and no repo. The two
 * cwd fallbacks must then answer null without touching the database.
 */
describe('resolving a project without a cwd', () => {
  it('AC5: skips the same-cwd fallback without an error', async () => {
    const { projectForCwd } = await import('./project-resolution')
    await expect(projectForCwd('u1', undefined)).resolves.toBeNull()
    await expect(projectForCwd('u1', '')).resolves.toBeNull()
    expect(touched).toEqual([])
  })

  it('AC9: skips the folder-name fallback too, without error', async () => {
    const { projectForCheckoutName } = await import('./project-resolution')
    await expect(projectForCheckoutName('u1', undefined)).resolves.toBeNull()
    await expect(projectForCheckoutName('u1', null)).resolves.toBeNull()
    expect(touched).toEqual([])
  })
})

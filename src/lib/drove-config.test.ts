import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(__dirname, '../..')
const read = (file: string) => readFileSync(resolve(root, file), 'utf8')

describe('drove config', () => {
  it('AC2: e2eSmoke runs test:smoke and the existing checks are unchanged and in order', () => {
    const config = JSON.parse(read('.drove.json'))
    expect(config.e2eSmoke).toEqual(['npm run test:smoke'])
    expect(config.checks).toEqual([
      'npm run typecheck',
      'npm run lint',
      'npm test',
      'npm run build',
      'npm run test:integration:local',
    ])
  })

  it('AC4: AGENTS.md documents the smoke set, its prerequisites and that it never runs in GitHub CI', () => {
    const guide = read('AGENTS.md')
    expect(guide).toContain('npm run test:smoke')
    expect(guide).toContain('Docker')
    expect(guide).toContain('Chromium')
    expect(guide).toMatch(/never\s+runs in GitHub CI/)
  })
})

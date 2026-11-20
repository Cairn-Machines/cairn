import { defineConfig, devices } from '@playwright/test'

// Browser tests run locally (the Drove merge gate, `.drove.json` e2eSmoke), never in GitHub CI.
// `npm run test:smoke` wraps this in scripts/with-throwaway-postgres.sh, which sets DATABASE_URL and
// removes its container on exit, and creates the test-only operator below.
export const SMOKE_EMAIL = 'smoke@example.test'
export const SMOKE_PASSWORD = 'smoke-test-only-password'

const port = Number(process.env.E2E_PORT) || 3217
const origin = `http://127.0.0.1:${port}`

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.smoke.spec.ts',
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 45_000,
  workers: 1,
  reporter: 'list',
  use: { baseURL: origin, headless: true, trace: 'retain-on-failure', ...devices['Desktop Chrome'] },
  projects: [{ name: 'chromium' }],
  webServer: {
    // Builds only when no production build exists (the merge gate builds first); then serves it.
    command: `sh -c 'test -f .next/BUILD_ID || npm run build; npx next start -H 127.0.0.1 -p ${port}'`,
    url: `${origin}/login`,
    env: { NODE_ENV: 'production', PORT: String(port), CAIRN_BASE_URL: origin, DATABASE_URL: process.env.DATABASE_URL ?? '' },
    reuseExistingServer: false,
    timeout: 180_000,
  },
})

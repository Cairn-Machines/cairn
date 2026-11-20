import { expect, test, type Page } from '@playwright/test'
import { SMOKE_EMAIL, SMOKE_PASSWORD } from '../playwright.config'

const WIDTHS = [
  { name: '1440', width: 1440, height: 900 },
  { name: '390', width: 390, height: 844 },
]

/** Console errors and uncaught page errors, collected for the whole test. */
const watchConsole = (page: Page) => {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  return errors
}

for (const { name, width, height } of WIDTHS) {
  test.describe(`${name} wide`, () => {
    test.use({ viewport: { width, height } })

    test(`@smoke login renders at ${name}`, async ({ page }) => {
      const errors = watchConsole(page)
      await page.goto('/login')
      await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
      await expect(page.getByLabel('Email')).toBeVisible()
      await expect(page.getByLabel('Password', { exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
      expect(errors).toEqual([])
    })

    test(`@smoke signed-in home renders at ${name}`, async ({ page }) => {
      const errors = watchConsole(page)
      await page.goto('/login')
      await page.getByLabel('Email').fill(SMOKE_EMAIL)
      await page.getByLabel('Password', { exact: true }).fill(SMOKE_PASSWORD)
      await page.getByRole('button', { name: 'Sign in' }).click()
      await page.waitForURL((url) => url.pathname === '/')
      // A fresh throwaway database has no projects: the home shows its empty state.
      await expect(page.getByRole('heading', { name: 'Nothing here yet' })).toBeVisible()
      expect(errors).toEqual([])
    })
  })
}

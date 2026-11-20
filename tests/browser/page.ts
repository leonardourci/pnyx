// The owner's page for the browser checks: the installed Chrome, headless, with its own profile and no Keychain prompt.
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import { afterAll, afterEach } from 'vitest'
import { localToken } from '#app/server-state.ts'
import { zeroCookieName } from '#app/server-protocol.ts'
import { zeroReady } from '../setup/zero.ts'

// Chrome started under a scratch HOME on macOS asks for a login keychain on the owner's screen without the first two;
// without smooth scrolling a wheel step lands at once.
const CHROME_FLAGS = [
  '--use-mock-keychain',
  '--password-store=basic',
  '--disable-smooth-scrolling',
]
const VIEWPORT = {
  width: 1440,
  height: 900,
}

let browser: Browser | undefined
const contexts = new Set<BrowserContext>()

// A page left open keeps rendering and would compete with the next check's frames.
afterEach(async () => {
  await Promise.all([...contexts].map(context => context.close()))
  contexts.clear()
})

afterAll(async () => {
  await browser?.close()
})

export async function openHydra({
  port,
  hydraId,
  reducedMotion = false,
  prepare,
}: {
  port: number
  hydraId: string
  // Rows then appear without their entrance animation, so only layout moves them.
  reducedMotion?: boolean
  // Runs before the page loads, such as installing a recorder.
  prepare?({ page }: { page: Page }): Promise<void>
}): Promise<Page> {
  // A page opened before zero-cache's first replica is ready waits out Zero's reconnect delay.
  await zeroReady({
    url: `http://127.0.0.1:${port}/zero/`,
    cookie: `${zeroCookieName({ port })}=${localToken()}`,
  })

  if (!browser) {
    browser = await chromium.launch({
      channel: 'chrome',
      headless: true,
      args: CHROME_FLAGS,
    })
  }

  const context = await browser.newContext({
    viewport: VIEWPORT,
    reducedMotion: reducedMotion ? 'reduce' : 'no-preference',
  })
  contexts.add(context)
  const page = await context.newPage()
  await prepare?.({ page })
  await page.goto(`http://127.0.0.1:${port}/hydra/${hydraId}/`)

  return page
}

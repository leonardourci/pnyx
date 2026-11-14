// The owner's browser for the journeys: the installed Chrome, headless, with its own profile and no Keychain prompt.
import { chromium, type Browser, type Page } from 'playwright-core'
import { afterAll } from 'vitest'
import { localToken } from '#app/server-state.ts'
import { zeroCookieName } from '#app/server-protocol.ts'
import { zeroReady } from './zero.ts'

// Chrome started under a scratch HOME on macOS asks for a login keychain on the owner's screen without these.
const KEYCHAIN_FLAGS = [
  '--use-mock-keychain',
  '--password-store=basic',
]

let browser: Browser | undefined

afterAll(async () => {
  await browser?.close()
})

export async function openHydra({
  port,
  hydraId,
  prepare,
}: {
  port: number
  hydraId: string
  // Runs before the page loads, such as routing its socket.
  prepare?({ page }: { page: Page }): Promise<void>
}): Promise<Page> {
  // A page opened before zero-cache's first replica is ready waits out Zero's reconnect delay.
  await zeroReady({
    url: `http://127.0.0.1:${port}/zero/`,
    cookie: `${zeroCookieName({ port })}=${localToken()}`,
  })
  browser ??= await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: KEYCHAIN_FLAGS,
  })
  const page = await (await browser.newContext({
    viewport: {
      width: 1440,
      height: 900,
    },
  })).newPage()
  await prepare?.({ page })
  await page.goto(`http://127.0.0.1:${port}/hydra/${hydraId}/`)

  return page
}

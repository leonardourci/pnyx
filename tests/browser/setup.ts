import { chromium, type Browser, type BrowserContext } from 'playwright-core'
import { afterAll, afterEach } from 'vitest'
import { localToken } from '#app/server-state.ts'
import { zeroCookieName } from '#app/server-protocol.ts'
import { zeroReady } from '../setup/zero.ts'

let browser: Browser | undefined
const contexts = new Set<BrowserContext>()

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
}: {
  port: number
  hydraId: string
}) {
  await zeroReady({
    url: `http://127.0.0.1:${port}/zero/`,
    cookie: `${zeroCookieName({ port })}=${localToken()}`,
  })

  if (!browser) {
    browser = await chromium.launch({
      channel: 'chrome',
      headless: true,
      args: [
        '--use-mock-keychain',
        '--password-store=basic',
      ],
    })
  }

  const context = await browser.newContext({
    viewport: {
      width: 1440,
      height: 900,
    },
  })
  contexts.add(context)
  const page = await context.newPage()
  await page.goto(`http://127.0.0.1:${port}/hydra/${hydraId}/`)

  return page
}

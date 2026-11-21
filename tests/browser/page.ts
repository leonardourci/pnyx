import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import { afterAll, afterEach } from 'vitest'

const NO_KEYCHAIN_PROMPT = [
  '--use-mock-keychain',
  '--password-store=basic',
]
const INSTANT_WHEEL_STEPS = ['--disable-smooth-scrolling']
const CHROME_FLAGS = [
  ...NO_KEYCHAIN_PROMPT,
  ...INSTANT_WHEEL_STEPS,
]
const VIEWPORT = {
  width: 1440,
  height: 900,
}

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
  reducedMotion = false,
  beforeLoad,
}: {
  port: number
  hydraId: string
  reducedMotion?: boolean
  beforeLoad?({ page }: { page: Page }): Promise<void>
}): Promise<Page> {
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
  await beforeLoad?.({ page })
  await page.goto(`http://127.0.0.1:${port}/hydra/${hydraId}/`)

  return page
}

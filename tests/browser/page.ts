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

export async function openTitan({
  port,
  titanId,
  reducedMotion = false,
  viewport = VIEWPORT,
  touch = false,
  beforeLoad,
}: {
  port: number
  titanId: string
  reducedMotion?: boolean
  viewport?: typeof VIEWPORT
  // A phone's touch screen: taps, a coarse pointer and no hover.
  touch?: boolean
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
    viewport,
    hasTouch: touch,
    isMobile: touch,
    reducedMotion: reducedMotion ? 'reduce' : 'no-preference',
  })
  contexts.add(context)
  const page = await context.newPage()
  await beforeLoad?.({ page })
  await page.goto(`http://127.0.0.1:${port}/titan/${titanId}/`)

  return page
}

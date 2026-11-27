import { chromium, webkit, type Browser, type BrowserContext, type Page } from 'playwright-core'
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

type Engine = 'chrome' | 'chromium' | 'webkit'

const launch = ({ engine }: { engine: Engine }) => engine === 'webkit'
  ? webkit.launch({ headless: true })
  : chromium.launch({
    channel: engine === 'chrome' ? 'chrome' : undefined,
    headless: true,
    args: CHROME_FLAGS,
  })

const browsers = new Map<Engine, Promise<Browser>>()
const contexts = new Set<BrowserContext>()

afterEach(async () => {
  await Promise.all([...contexts].map(context => context.close()))
  contexts.clear()
})

afterAll(async () => {
  await Promise.all([...browsers.values()].map(async browser => (await browser).close()))
})

export async function openTitan({
  port,
  titanId,
  engine = 'chrome',
  reducedMotion = false,
  viewport = VIEWPORT,
  touch = false,
  beforeLoad,
}: {
  port: number
  titanId: string
  engine?: Engine
  reducedMotion?: boolean
  viewport?: typeof VIEWPORT
  touch?: boolean
  beforeLoad?({ page }: { page: Page }): Promise<void>
}): Promise<Page> {
  let browser = browsers.get(engine)

  if (!browser) {
    browser = launch({ engine })
    browsers.set(
      engine,
      browser,
    )
  }

  let launched: Browser

  try {
    launched = await browser
  } catch (error) {
    if (browsers.get(engine) === browser) {
      browsers.delete(engine)
    }

    throw error
  }

  const context = await launched.newContext({
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

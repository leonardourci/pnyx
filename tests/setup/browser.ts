// The owner's browser for the journeys: the installed Chrome, headless, with its own profile and no Keychain prompt.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import { afterAll, afterEach, beforeEach } from 'vitest'
import { localToken } from '#app/server-state.ts'
import { zeroCookieName } from '#app/server-protocol.ts'
import { zeroReady } from './zero.ts'

// Chrome started under a scratch HOME on macOS asks for a login keychain on the owner's screen without these.
const KEYCHAIN_FLAGS = [
  '--use-mock-keychain',
  '--password-store=basic',
]

let browser: Browser | undefined
const contexts = new Set<BrowserContext>()

let evidenceTask = ''
let evidenceIndex = 0
beforeEach(({task}) => {
  evidenceTask = task.id
  evidenceIndex = 0
})

async function retainContext({
  context,
  task,
}: {
  context: BrowserContext
  task: string
}) {
  const kept = process.env.PNYX_KEEP_TEST_FILES

  if (!kept) {
    return
  }

  const folder = join(
    kept,
    'browser',
    task,
  )
  mkdirSync(
    folder,
    {recursive: true},
  )

  for (const page of context.pages()) {
    if (page.isClosed()) {
      continue
    }

    const path = join(
      folder,
      String(evidenceIndex++),
    )
    // Evidence is best effort: a page that crashed or closed still keeps whatever else can be read, and the
    // test's own failure is what gets reported.
    await page.screenshot({path: `${path}.png`}).catch(() => {})
    writeFileSync(
      `${path}.html`,
      await page.content().catch(() => 'Page unavailable'),
    )
    writeFileSync(
      `${path}.json`,
      JSON.stringify(
        await page.evaluate(() => ({
          url: location.href,
          focus: document.activeElement?.outerHTML.slice(
            0,
            1000,
          ),
          axis: document.querySelector('.workspace-axis')?.scrollLeft,
          window: {
            x: scrollX,
            y: scrollY,
          },
          workspaces: [...document.querySelectorAll<HTMLElement>('[data-hydra-workspace]')].map(node => ({
            id: node.dataset.hydraWorkspace,
            box: node.getBoundingClientRect().toJSON(),
            cards: node.querySelectorAll('.card-open').length,
            offset: node.dataset.axisOffset,
            columns: [...node.querySelectorAll<HTMLElement>('.project-column')].map(column => ({
              id: column.dataset.column,
              box: column.getBoundingClientRect().toJSON(),
            })),
          })),
        })).catch(() => null),
        null,
        2,
      ),
    )
  }
}

afterEach(async ({ task }) => {
  if (task.result?.state === 'fail') {
    for (const context of contexts) {
      await retainContext({
        context,
        task: task.id,
      })
    }
  }

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
  // The page then shows each streamed push as it lands instead of typing it out.
  reducedMotion?: boolean
  // Runs before the page loads, such as routing its socket.
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
      args: KEYCHAIN_FLAGS,
    })
  }

  const context = await browser.newContext({
    viewport: {
      width: 1440,
      height: 900,
    },
    reducedMotion: reducedMotion ? 'reduce' : 'no-preference',
  })

  if (process.env.PNYX_KEEP_TEST_FILES) {
    await context.tracing.start({
      screenshots: true,
      snapshots: true,
      sources: true,
    })
  }

  contexts.add(context)
  const close = context.close.bind(context)
  const task = evidenceTask

  // Explicit closes in a test's finally block run before afterEach can retain its page.
  // eslint-disable-next-line pnyx/object-params -- Playwright owns the close method signature.
  context.close = async options => {
    if (!contexts.has(context)) {
      return close(options)
    }

    await retainContext({
      context,
      task,
    })
    const kept = process.env.PNYX_KEEP_TEST_FILES

    if (kept) {
      await context.tracing.stop({
        path: join(
          kept,
          'browser',
          task,
          `${evidenceIndex++}-trace.zip`,
        ),
      })
    }

    contexts.delete(context)
    await close(options)
  }

  const page = await context.newPage()
  await prepare?.({ page })
  await page.goto(`http://127.0.0.1:${port}/hydra/${hydraId}/`)

  return page
}

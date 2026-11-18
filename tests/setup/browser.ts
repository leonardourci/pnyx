// The owner's browser for the journeys: the installed Chrome, headless, with its own profile and no Keychain prompt.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import { afterAll, afterEach } from 'vitest'
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

afterEach(async ({ task }) => {
  const kept = process.env.PNYX_KEEP_TEST_FILES

  if (kept && task.result?.state === 'fail') {
    const folder = join(
      kept,
      'browser',
      task.id,
    )
    mkdirSync(
      folder,
      { recursive: true },
    )
    let index = 0

    for (const context of contexts) {
      for (const page of context.pages()) {
        if (!page.isClosed()) {
          const path = join(
            folder,
            String(index++),
          )
          await page.screenshot({ path: `${path}.png` }).catch(() => {})
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
                workspaces: [...document.querySelectorAll<HTMLElement>('[data-hydra-workspace]')].map(node => ({
                  id: node.dataset.hydraWorkspace,
                  box: node.getBoundingClientRect().toJSON(),
                  cards: node.querySelectorAll('.card-open').length,
                  offset: node.dataset.axisOffset,
                })),
              })).catch(() => null),
              null,
              2,
            ),
          )
        }
      }
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
  contexts.add(context)
  const page = await context.newPage()
  await prepare?.({ page })
  await page.goto(`http://127.0.0.1:${port}/hydra/${hydraId}/`)

  return page
}

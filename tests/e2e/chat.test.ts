import { beforeAll, expect, test } from 'vitest'
import type { Page } from 'playwright-core'
import { openHydra } from '../setup/browser.ts'
import { startPnyx, until, type Pnyx } from '../setup/pnyx.ts'

let pnyx: Pnyx

beforeAll(async () => {
  pnyx = await startPnyx({ zeroCache: true })
})

const CONVERSATION = '[aria-label="Hydra conversation"]'
const COMPOSER = '[aria-label="Reply to Hydra"]'

test(
  'the owner\'s message shows at once, the reply streams in, a message sent meanwhile waits queued, Stop ends the turn and cancels that message until it is sent again, and a reload keeps the conversation',
  async () => {
    const hydra = await pnyx.hydra()
    const page = await openHydra({
      port: pnyx.port(),
      hydraId: hydra.id,
    })
    const conversation = page.locator(CONVERSATION)
    pnyx.claude.plan({
      hydra: hydra.id,
      text: 'Plan the release',
      reply: 'Release plan: **freeze on Monday**, ship on Thursday.',
      partial: 'Release plan: **freeze on Mon',
      hold: true,
    })
    pnyx.claude.plan({
      hydra: hydra.id,
      text: 'Also list the risks',
      reply: 'Risks: the migration and the new billing page. <img src=x onerror=alert(1)> [open](javascript:alert(1))',
    })

    await page.fill(
      COMPOSER,
      'Plan the release',
    )
    await page.click('[aria-label="Send reply"]')
    await conversation.getByText('Plan the release').waitFor()
    await conversation.getByText('Release plan:').waitFor()
    // The page types about seven letters a frame, so the text has stopped moving a few dozen frames later.
    const streamed = await until({
      what: 'the streamed text to stop moving',
      check: () => page.evaluate(
        // eslint-disable-next-line pnyx/object-params -- Playwright owns this callback's signature.
        async selector => {
          const read = () => document.querySelector(selector)!.textContent ?? ''
          const start = read()

          for (let frame = 0; frame < 40; frame++) {
            await new Promise(requestAnimationFrame)

            if (read() !== start) {
              return undefined
            }
          }

          return start
        },
        CONVERSATION,
      ),
    })
    // Half-written Markdown stays hidden until its closing marker arrives.
    expect(streamed).toContain('Release plan:')
    expect(streamed).not.toContain('**')
    expect(streamed).not.toContain('freeze')
    expect(await conversation.locator('strong').count()).toBe(0)

    await page.fill(
      COMPOSER,
      'Also list the risks',
    )
    await page.click('[aria-label="Send reply"]')
    await conversation.getByText('Queued').waitFor()

    await page.click('[aria-label="Stop Hydra"]')
    await conversation.getByText('Not delivered: stopped').waitFor()
    expect(await conversation.textContent()).not.toContain('ship on Thursday')
    expect(await conversation.textContent()).not.toContain('Risks:')
    await page.click('[aria-label="Send this message again"]')
    await conversation.getByText('Risks: the migration and the new billing page.').waitFor()
    // Raw HTML and a javascript: link in a reply show as text, never as a tag or a link.
    expect(await conversation.textContent()).toContain('<img src=x onerror=alert(1)>')
    expect(await conversation.locator('img').count()).toBe(0)
    expect(await conversation.locator('a[href^="javascript:" i]').count()).toBe(0)

    await page.reload()
    await conversation.getByText('Risks: the migration and the new billing page.').waitFor()
    const text = await conversation.textContent() ?? ''
    expect(text.split('Plan the release')).toHaveLength(2)
    // The stopped message stays beside the copy that was sent again.
    expect(text.split('Also list the risks')).toHaveLength(3)
    expect(text.split('Risks: the migration and the new billing page.')).toHaveLength(2)
  },
)

test(
  'with reduced motion a streamed push shows as it lands, and a half-written bold marker stays hidden until it is closed',
  async () => {
    const hydra = await pnyx.hydra()
    const page = await openHydra({
      port: pnyx.port(),
      hydraId: hydra.id,
      reducedMotion: true,
    })
    const conversation = page.locator(CONVERSATION)
    const turn = pnyx.claude.plan({
      hydra: hydra.id,
      text: 'Summarize the plan',
      reply: 'Plan: **freeze on Monday**.',
      partial: 'Plan: **freeze on Mon',
      hold: true,
    })

    await page.fill(
      COMPOSER,
      'Summarize the plan',
    )
    await page.click('[aria-label="Send reply"]')
    await conversation.getByText('Plan:').waitFor()
    const partial = await conversation.textContent() ?? ''
    expect(partial).not.toContain('**')
    expect(partial).not.toContain('freeze')

    turn.release()
    await conversation.locator('strong').getByText('freeze on Monday')
      .waitFor()
  },
)

// The rows in view by entry, with their offset from the top of the conversation, and the list's height.
const view = ({ page }: { page: Page }) => page.evaluate(
  // eslint-disable-next-line pnyx/object-params -- Playwright owns this callback's signature.
  selector => {
    const scroller = document.querySelector(selector)!
    const top = scroller.getBoundingClientRect().top
    const rows = [...scroller.querySelectorAll<HTMLElement>('article[data-entry-id]')].map(article => [
      article.dataset.entryId!,
      article.getBoundingClientRect().top - top,
    ] as const).filter(([
      , offset,
    ]) => offset >= 0 && offset < scroller.clientHeight)

    return {
      height: scroller.scrollHeight,
      rows: Object.fromEntries(rows),
    }
  },
  CONVERSATION,
)

// Still: the same view across two reads a frame apart.
const still = async ({ page }: { page: Page }) => {
  const first = JSON.stringify(await view({ page }))
  await page.evaluate(() => new Promise(requestAnimationFrame))

  return first === JSON.stringify(await view({ page }))
}

// A Hydra whose chat holds 25 exchanges: three pages of 20 entries, newest first.
const longConversation = async () => {
  const hydra = await pnyx.hydra()

  for (let exchange = 1; exchange <= 25; exchange++) {
    pnyx.claude.plan({
      hydra: hydra.id,
      text: `question ${exchange}`,
      reply: `answer ${exchange}`,
    })
    const session = await hydra.chat({ text: `question ${exchange}` })
    await until({
      what: `answer ${exchange}`,
      check: () => session.answered === exchange,
    })
  }

  return hydra
}

test(
  'a long conversation opens on its newest messages, and scrolling up loads the older pages until the first message',
  async () => {
    const hydra = await longConversation()
    const page = await openHydra({
      port: pnyx.port(),
      hydraId: hydra.id,
    })
    const conversation = page.locator(CONVERSATION)
    await conversation.getByText(
      'answer 25',
      { exact: true },
    ).waitFor()
    expect(await conversation.getByText(
      'question 1',
      { exact: true },
    ).count()).toBe(0)

    await conversation.hover()
    await until({
      what: 'scrolling up to reach the first message',
      check: async () => {
        await page.mouse.wheel(
          0,
          -2000,
        )

        return await conversation.getByText(
          'question 1',
          { exact: true },
        ).count() > 0
      },
    })
    await conversation.getByText(
      'answer 1',
      { exact: true },
    ).waitFor()
    expect(await conversation.getByText(
      'question 1',
      { exact: true },
    ).count()).toBe(1)
  },
)

test(
  'an older page that lands while the owner holds still at the top leaves what they read in place',
  async () => {
    const hydra = await longConversation()

    // The server's messages from a reply to an older-page read on wait here while holding, so the test decides when it lands.
    const olderReads = new Set<string>()
    const held: (() => void)[] = []
    let holding = false
    const page = await openHydra({
      port: pnyx.port(),
      hydraId: hydra.id,
      prepare: ({ page }) => page.routeWebSocket(
        /\/ws\?/,
        // eslint-disable-next-line pnyx/object-params -- Playwright owns this callback's signature.
        socket => {
          const server = socket.connectToServer()
          // eslint-disable-next-line pnyx/object-params -- Playwright owns this callback's signature.
          socket.onMessage(message => {
            const sent = JSON.parse(String(message)) as {
              type?: string
              id?: string
              name?: string
              args?: string[]
            }

            if (sent.type === 'command' && sent.name === 'thread' && sent.args !== undefined && sent.args.length > 1) {
              olderReads.add(sent.id!)
            }

            server.send(message)
          })
          // eslint-disable-next-line pnyx/object-params -- Playwright owns this callback's signature.
          server.onMessage(message => {
            const { id } = JSON.parse(String(message)) as { id?: string }

            // A socket keeps its order, so everything after a held reply waits behind it.
            if (held.length || (holding && id && olderReads.has(id))) {
              held.push(() => socket.send(message))
            } else {
              socket.send(message)
            }
          })
        },
      ),
    })
    const conversation = page.locator(CONVERSATION)
    await conversation.getByText(
      'answer 25',
      { exact: true },
    ).waitFor()
    expect(await conversation.getByText(
      'question 1',
      { exact: true },
    ).count()).toBe(0)

    await conversation.hover()
    holding = true
    await until({
      what: 'scrolling up to ask for an older page',
      check: async () => {
        await page.mouse.wheel(
          0,
          -2000,
        )

        return held.length > 0
      },
    })
    await until({
      what: 'the view to hold still',
      check: () => still({ page }),
    })
    const before = await view({ page })

    holding = false
    held.splice(0).forEach(release => release())
    const after = await until({
      what: 'the older page to land',
      check: async () => {
        const now = await view({ page })

        return now.height > before.height && await still({ page }) && now
      },
    })
    const kept = Object.keys(before.rows).filter(id => id in after.rows)
    expect(kept.length).toBeGreaterThan(0)

    for (const id of kept) {
      expect(Math.abs(after.rows[id]! - before.rows[id]!)).toBeLessThanOrEqual(3)
    }
  },
)

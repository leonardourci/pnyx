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

// A Hydra whose chat holds 25 exchanges, or the given number: pages of 20 entries, newest first.
const longConversation = async ({ exchanges = 25 }: { exchanges?: number } = {}) => {
  const hydra = await pnyx.hydra()

  for (let exchange = 1; exchange <= exchanges; exchange++) {
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

// A Hydra whose chat holds 25 exchanges with a compaction after the 3rd, 5th, 21st and 23rd.
const compactedConversation = async () => {
  const hydra = await pnyx.hydra()
  let compacted = 0

  for (let exchange = 1; exchange <= 25; exchange++) {
    pnyx.claude.plan({
      hydra: hydra.id,
      text: `question ${exchange}`,
      reply: `answer ${exchange}`,
    })
    const session = await hydra.chat({ text: `question ${exchange}` })
    await until({
      what: `answer ${exchange}`,
      check: () => session.answered >= exchange + compacted,
    })

    if (![
      3,
      5,
      21,
      23,
    ].includes(exchange)) {
      continue
    }

    pnyx.claude.plan({
      hydra: hydra.id,
      text: '/compact',
      compacting: true,
    })
    await hydra.owner({
      args: [
        'hydra',
        'send',
        '--text',
        '/compact',
      ],
    })
    compacted += 1
    await until({
      what: `compaction ${compacted}`,
      check: () => session.answered >= exchange + compacted,
    })
  }

  return hydra
}

const LOADING = '[aria-label="Loading earlier messages"]'

// The conversation's rendered rows top to bottom: each message's text start, and "compaction" for each notice.
const timeline = ({ page }: { page: Page }) => page.evaluate(
  // eslint-disable-next-line pnyx/object-params -- Playwright owns this callback's signature.
  selector => [...document.querySelector(selector)!.querySelectorAll<HTMLElement>('article.message, .compaction-row')]
    .filter(row => !row.querySelector('.compaction-row'))
    .map(row => row.classList.contains('compaction-row')
      ? 'compaction'
      : row.textContent!.replace(
        /[\u2060\s]+/g,
        ' ',
      ).trim()
        .slice(
          0,
          14,
        )),
  CONVERSATION,
)

test(
  'scrolling to the top loads the older page there with a spinner only while it loads, the view holds still, and each compaction notice sits between the messages around its moment',
  async () => {
    const hydra = await compactedConversation()

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
    expect(await page.locator(LOADING).count()).toBe(0)

    // Scrolling up asks for the first older page, and the spinner shows while it is held.
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
    await page.locator(LOADING).waitFor({ state: 'attached' })
    // The owner reads a little below the top, so an older page lands above what they read.
    await page.mouse.wheel(
      0,
      300,
    )
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

    await page.locator(LOADING).waitFor({ state: 'detached' })

    // At the top of two pages, with the third on its way, the compactions older than them are not piled above the messages.
    holding = true
    await until({
      what: 'scrolling up to ask for the next older page',
      check: async () => {
        await page.mouse.wheel(
          0,
          -3000,
        )

        return held.length > 0
      },
    })
    await page.locator(LOADING).waitFor({ state: 'attached' })
    await until({
      what: 'the view to hold still at the top of the loaded messages',
      check: () => still({ page }),
    })
    const loaded = await timeline({ page })
    expect(loaded[0]).not.toBe('compaction')

    holding = false
    held.splice(0).forEach(release => release())
    await page.locator(LOADING).waitFor({ state: 'detached' })

    // Scroll on to the first message: the oldest compaction sits after the /compact that started it, between answer 3 and question 4.
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
    const everything = await timeline({ page })
    const first = everything.indexOf('compaction')
    expect(first).toBeGreaterThan(everything.indexOf('answer 3'))
    expect(first).toBeLessThan(everything.indexOf('question 4'))
    expect(everything[first - 1]).toBe('/compact')
    expect(everything.indexOf('question 1')).toBeLessThan(first)
  },
)

// A window tall enough that the three recent pages sit inside the screen and the older-page margin, as a Hydra chat of
// folded tool rows does at a normal height. The fake chat's rows are taller, so the test makes the window taller.
const RECENT_PAGES_IN_RANGE = 5400
// The recent pages fit without scrolling, so a wheel-up has nothing to scroll.
const RECENT_PAGES_FIT = 6500
// 45 exchanges are 90 entries, five pages of 20: more than the three-page recent window.
const LONG_CHAT_EXCHANGES = 45

// Opens a chat with a window of the given height, and counts the thread reads its page sends and the ResizeObserver
// loop errors it raises.
const openCounted = async ({
  hydraId,
  height,
}: {
  hydraId: string
  height: number
}) => {
  const reads: string[] = []
  const page = await openHydra({
    port: pnyx.port(),
    hydraId,
    prepare: async ({ page }) => {
      await page.addInitScript(() => {
        const counts = { resizeLoops: 0 }
        Object.assign(
          window,
          { counts },
        )
        window.addEventListener(
          'error',
          event => {
            if (event.message.includes('ResizeObserver loop')) {
              counts.resizeLoops++
            }
          },
        )
      })
      page.on(
        'websocket',
        socket => socket.on(
          'framesent',
          frame => {
            const sent = JSON.parse(String(frame.payload)) as {
              type?: string
              name?: string
            }

            if (sent.type === 'command' && sent.name === 'thread') {
              reads.push(String(frame.payload))
            }
          },
        ),
      )
      await page.setViewportSize({
        width: 1440,
        height,
      })
    },
  })

  return {
    page,
    reads,
  }
}

// The scroll offset and height the chat had at each of the given animation frames, without repeats.
const watchFrames = ({
  page,
  frames,
}: {
  page: Page
  frames: number
}) => page.evaluate(

  async ({
    selector,
    frames,
  }) => {
    const scroller = document.querySelector<HTMLElement>(selector)!
    const steps = new Set<string>()

    for (let frame = 0; frame < frames; frame++) {
      await new Promise(requestAnimationFrame)
      steps.add(`${Math.round(scroller.scrollTop)}/${scroller.scrollHeight}`)
    }

    return [...steps]
  },
  {
    selector: CONVERSATION,
    frames,
  },
)

// The ResizeObserver loop errors the page has raised since it opened.
const resizeLoopErrors = ({ page }: { page: Page }) => page.evaluate(
  () => (window as unknown as { counts: { resizeLoops: number } }).counts.resizeLoops,
)

const WATCHED_FRAMES = 120

test(
  'resting at the bottom of a long chat during a live turn reads no older page and keeps the view still, and a reply landing while the owner reads further up leaves the rows in view in place with no ResizeObserver loop error',
  async () => {
    const hydra = await longConversation({ exchanges: LONG_CHAT_EXCHANGES })
    const {
      page,
      reads,
    } = await openCounted({
      hydraId: hydra.id,
      height: RECENT_PAGES_IN_RANGE,
    })
    const conversation = page.locator(CONVERSATION)
    const turn = pnyx.claude.plan({
      hydra: hydra.id,
      text: 'one more',
      reply: 'A longer reply that streams in while the owner reads further up.',
      partial: 'A longer reply that streams in',
      hold: true,
    })
    // The newest three pages, 60 entries, start at question 16.
    await conversation.getByText(
      'question 16',
      { exact: true },
    ).waitFor()
    await page.fill(
      COMPOSER,
      'one more',
    )
    await page.click('[aria-label="Send reply"]')
    await conversation.getByText('A longer reply that streams in').waitFor()
    reads.length = 0

    const steps = await watchFrames({
      page,
      frames: WATCHED_FRAMES,
    })

    expect(reads).toHaveLength(0)
    expect(steps).toHaveLength(1)

    await conversation.hover()
    await page.mouse.wheel(
      0,
      -400,
    )
    await page.locator(`${CONVERSATION}[data-away]`).waitFor()
    await until({
      what: 'the view to hold still',
      check: () => still({ page }),
    })
    const before = await view({ page })

    turn.release()
    await watchFrames({
      page,
      frames: WATCHED_FRAMES,
    })
    await conversation.getByText('while the owner reads further up.').waitFor()
    const after = await view({ page })
    const kept = Object.keys(before.rows).filter(id => id in after.rows)

    expect(kept.length).toBeGreaterThan(0)

    for (const id of kept) {
      expect(Math.abs(after.rows[id]! - before.rows[id]!)).toBeLessThanOrEqual(3)
    }

    // Since the page opened: the stream starting, resting at the bottom, scrolling up and the reply landing.
    expect(await resizeLoopErrors({ page })).toBe(0)
  },
)

test(
  'wheeling up in a chat too short to scroll leaves the bottom and keeps the older pages it loads',
  async () => {
    const hydra = await longConversation({ exchanges: LONG_CHAT_EXCHANGES })
    const {
      page,
      reads,
    } = await openCounted({
      hydraId: hydra.id,
      height: RECENT_PAGES_FIT,
    })
    const conversation = page.locator(CONVERSATION)
    await conversation.getByText(
      'question 16',
      { exact: true },
    ).waitFor()
    expect(await conversation.getByText(
      'question 1',
      { exact: true },
    ).count()).toBe(0)
    reads.length = 0
    await watchFrames({
      page,
      frames: WATCHED_FRAMES,
    })
    expect(reads).toHaveLength(0)

    await conversation.hover()
    await until({
      what: 'wheeling up to load the older pages down to the first message',
      check: async () => {
        await page.mouse.wheel(
          0,
          -400,
        )

        return await conversation.getByText(
          'question 1',
          { exact: true },
        ).count() > 0
      },
    })
    await page.locator(`${CONVERSATION}[data-away]`).waitFor()
    await until({
      what: 'the view to hold still',
      check: () => still({ page }),
    })
    expect(await conversation.getByText(
      'answer 1',
      { exact: true },
    ).count()).toBe(1)
  },
)

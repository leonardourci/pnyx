import { beforeAll, expect, test } from 'vitest'
import type { Page } from 'playwright-core'
import { startPnyx, until, type Hydra, type Pnyx } from '../setup/pnyx.ts'
import { appendRecords } from '../setup/transcripts.ts'
import { openHydra } from './page.ts'

let pnyx: Pnyx

beforeAll(async () => {
  pnyx = await startPnyx({ zeroCache: true })
})

const EXCHANGES = 12
const WORKER_MESSAGES = 40
// Painted frames after a load for its rows to come into view and take their size, and after one change, a new row or
// a Jump, for it to paint.
const SETTLING_FRAMES = 10
const ARRIVAL_FRAMES = 2
// Enough lines that the conversation is several screens tall.
const paragraph = ({ label }: { label: string }) => `${label}\n\n${'A line of the release notes that fills the width. '.repeat(6)}`

interface Frame {
  label: string
  fromBottom: number
  scrolls: boolean
  // The first row the chat has loaded, shown or not.
  first?: string
  // Each shown row's distance from the bottom of its chat.
  rows: Record<string, number>
}

// Records, for every frame from the first, where each chat sits and where its rows are as painted: the sample runs
// after the frame, and a frame whose page changed after it rendered is not one the owner saw.
function recordChats() {
  const frames: Frame[] = []
  Object.assign(
    window,
    { chatFrames: frames },
  )
  let changed = false
  new MutationObserver(() => {
    changed = true
  }).observe(
    document,
    {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    },
  )

  const sample = () => {
    if (changed) {
      return
    }

    for (const chat of document.querySelectorAll<HTMLElement>('.chat-messages')) {
      const box = chat.getBoundingClientRect()
      const loaded = [...chat.querySelectorAll<HTMLElement>('[data-entry-id]')]
      const shown = loaded.filter(row => {
        const bounds = row.getBoundingClientRect()

        return bounds.bottom > box.top && bounds.top < box.bottom
      })

      if (shown.length) {
        frames.push({
          label: chat.getAttribute('aria-label')!,
          fromBottom: chat.scrollHeight - chat.clientHeight - chat.scrollTop,
          scrolls: chat.scrollHeight > chat.clientHeight + 1,
          first: loaded[0]?.dataset.entryId,
          rows: Object.fromEntries(shown.map(row => [
            row.dataset.entryId!,
            Math.round(box.bottom - row.getBoundingClientRect().bottom),
          ])),
        })
      }
    }
  }

  const painted = new MessageChannel()
  painted.port1.onmessage = sample

  const frame = () => {
    changed = false
    painted.port2.postMessage(null)
    requestAnimationFrame(frame)
  }

  requestAnimationFrame(frame)
}

const framesOf = async ({
  page,
  label,
}: {
  page: Page
  label: string
}) => (await page.evaluate(() => (window as unknown as { chatFrames: Frame[] }).chatFrames))
  .filter(frame => frame.label === label)

// Rows that moved from one frame to the next while the owner did nothing.
const moves = ({ frames }: { frames: Frame[] }) => frames.slice(1).flatMap((
  frame,
  index,
) => Object.entries(frame.rows)
  .filter(([
    id,
    offset,
  ]) => {
    const before = frames[index]!.rows[id]

    return before !== undefined && Math.abs(before - offset) > 1
  })
  .map(([id]) => id))

const offEnd = ({ frames }: { frames: Frame[] }) => frames.map(frame => frame.fromBottom)
  .filter(distance => distance > 1)

const nextFrames = ({
  page,
  count,
}: {
  page: Page
  count: number
}) => page.evaluate(
  async frames => {
    for (let frame = 0; frame < frames; frame++) {
      await new Promise(requestAnimationFrame)
    }
  },
  count,
)

const shownText = ({
  page,
  chat,
  text,
}: {
  page: Page
  chat: string
  text: string
}) => page.getByRole(
  'region',
  { name: chat },
).getByText(text)
  .filter({ visible: true })
  .waitFor()

const exchange = async ({
  hydra,
  number,
}: {
  hydra: Hydra
  number: number
}) => {
  pnyx.claude.plan({
    hydra: hydra.id,
    text: `question ${number}`,
    reply: paragraph({ label: `answer ${number}` }),
  })
  const session = await hydra.chat({ text: `question ${number}` })
  const turn = session.received.findLastIndex(text => text.includes(`question ${number}`))
  await until({
    what: `answer ${number}`,
    check: () => session.answered > turn,
  })
}

// A Hydra whose conversation is several screens and more than one page long.
async function seededHydra() {
  const hydra = await pnyx.hydra()

  for (let number = 1; number <= EXCHANGES; number++) {
    await exchange({
      hydra,
      number,
    })
  }

  return hydra
}

const workerNotes = ({
  from,
  count,
}: {
  from: number
  count: number
}) => Array.from(
  { length: count },
  (
    _,
    index,
  ) => ({
    type: 'assistant' as const,
    content: paragraph({ label: `worker note ${from + index}` }),
  }),
)

const setFocusMode = ({
  hydra,
  on,
}: {
  hydra: Hydra
  on: boolean
}) => hydra.owner({
  args: [
    'settings',
    'set',
    '--json',
    JSON.stringify({ focusMode: on }),
  ],
})

test(
  'Hydra\'s chat and a task\'s chat open on their latest row, hold still and keep the end in view as rows arrive, in a card as tall as its column',
  async () => {
    const hydra = await seededHydra()
    const { worker } = await hydra.startTask({ key: 'notes' })
    await appendRecords({
      session: worker,
      records: workerNotes({
        from: 1,
        count: WORKER_MESSAGES,
      }),
    })

    const page = await openHydra({
      port: pnyx.port(),
      hydraId: hydra.id,
      reducedMotion: true,
      prepare: async ({ page }) => {
        await page.addInitScript(recordChats)
      },
    })
    await shownText({
      page,
      chat: 'Hydra conversation',
      text: `answer ${EXCHANGES}`,
    })
    await nextFrames({
      page,
      count: SETTLING_FRAMES,
    })
    const opened = await framesOf({
      page,
      label: 'Hydra conversation',
    })
    expect(opened.length).toBeGreaterThan(0)
    expect(opened.at(-1)!.scrolls).toBe(true)
    expect(offEnd({ frames: opened })).toEqual([])
    expect(moves({ frames: opened })).toEqual([])

    await exchange({
      hydra,
      number: EXCHANGES + 1,
    })
    await shownText({
      page,
      chat: 'Hydra conversation',
      text: `answer ${EXCHANGES + 1}`,
    })
    await nextFrames({
      page,
      count: ARRIVAL_FRAMES,
    })
    expect(offEnd({
      frames: await framesOf({
        page,
        label: 'Hydra conversation',
      }),
    })).toEqual([])

    const card = page.locator('[data-task]').filter({ hasText: 'Task notes' })
    await card.getByText(
      'Task notes',
      { exact: true },
    ).click()
    await shownText({
      page,
      chat: 'Task notes conversation',
      text: `worker note ${WORKER_MESSAGES}`,
    })
    await nextFrames({
      page,
      count: SETTLING_FRAMES,
    })
    const taskOpened = await framesOf({
      page,
      label: 'Task notes conversation',
    })
    expect(taskOpened.length).toBeGreaterThan(0)
    expect(taskOpened.at(-1)!.scrolls).toBe(true)
    expect(offEnd({ frames: taskOpened })).toEqual([])
    expect(moves({ frames: taskOpened })).toEqual([])
    const heights = await card.evaluate(element => {
      const column = element.closest<HTMLElement>('.column-cards')!
      const css = getComputedStyle(column)

      return {
        card: element.getBoundingClientRect().height,
        column: column.clientHeight - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom),
      }
    })
    expect(Math.abs(heights.card - heights.column)).toBeLessThanOrEqual(1)

    await appendRecords({
      session: worker,
      records: workerNotes({
        from: WORKER_MESSAGES + 1,
        count: 1,
      }),
    })
    await shownText({
      page,
      chat: 'Task notes conversation',
      text: `worker note ${WORKER_MESSAGES + 1}`,
    })
    await nextFrames({
      page,
      count: ARRIVAL_FRAMES,
    })
    expect(offEnd({
      frames: await framesOf({
        page,
        label: 'Task notes conversation',
      }),
    })).toEqual([])
  },
)

test(
  'with Focus mode on, a running tool call is named in neither Hydra\'s nor a task\'s working line, and a card\'s status never names one',
  async () => {
    const hydra = await pnyx.hydra()
    await hydra.startTask({ key: 'build' })
    await setFocusMode({
      hydra,
      on: false,
    })
    const build = ({ id }: { id: string }) => ({
      id,
      name: 'Bash',
      input: { command: 'pnpm build' },
    })
    const hydraTurn = pnyx.claude.plan({
      hydra: hydra.id,
      text: 'Check the build',
      reply: 'The build passes.',
      tool: build({ id: 'toolu_hydra_build' }),
      hold: true,
    })
    const workerTurn = pnyx.claude.plan({
      hydra: hydra.id,
      match: ({ text }) => text.includes('Run the build'),
      reply: 'Built.',
      tool: build({ id: 'toolu_worker_build' }),
      hold: true,
    })

    try {
      const page = await openHydra({
        port: pnyx.port(),
        hydraId: hydra.id,
      })
      await hydra.chat({ text: 'Check the build' })
      await hydra.owner({
        args: [
          'reply',
          'build',
          '--text',
          'Run the build',
        ],
      })
      await page.locator('[data-task]').getByText(
        'Task build',
        { exact: true },
      )
        .click()
      const working = [
        page.getByRole(
          'status',
          { name: 'Hydra is working' },
        ),
        page.getByRole(
          'status',
          { name: 'Worker is working' },
        ),
      ]

      for (const line of working) {
        await line.getByText('Running a command').waitFor()
      }

      // The card's status explains itself on hover or focus, and never names a tool: the chat shows the calls.
      await page.locator('[data-task] .agent-activity').focus()
      expect(await page.getByRole('tooltip').textContent()).toBe('working')

      await setFocusMode({
        hydra,
        on: true,
      })
      await until({
        what: 'both working lines to stop naming the tool',
        check: async () => {
          const texts = await Promise.all(working.map(line => line.textContent()))

          return texts.every(text => text !== null && !text.includes('Running a command'))
        },
      })
    } finally {
      hydraTurn.release()
      workerTurn.release()
      await setFocusMode({
        hydra,
        on: true,
      })
    }
  },
)

test(
  'reading back, older messages load above the ones on screen without moving them, and Jump returns to the latest',
  async () => {
    const hydra = await seededHydra()
    // The answer to an older-page read waits here, so the reading position paints before the rows arrive.
    const olderReads = new Set<string>()
    const heldAnswers: (() => void)[] = []
    const page = await openHydra({
      port: pnyx.port(),
      hydraId: hydra.id,
      reducedMotion: true,
      prepare: async ({ page }) => {
        await page.addInitScript(recordChats)
        await page.routeWebSocket(
          /\/ws(\?|$)/,
          socket => {
            const server = socket.connectToServer()
            socket.onMessage(message => {
              const sent = JSON.parse(String(message)) as {
                id?: string
                name?: string
                args?: string[]
              }

              if (sent.name === 'thread' && sent.args?.length === 2 && !sent.args[1]!.startsWith('--')) {
                olderReads.add(sent.id!)
              }

              server.send(message)
            })
            server.onMessage(message => {
              const answer = JSON.parse(String(message)) as { id?: string }

              if (answer.id !== undefined && olderReads.has(answer.id)) {
                heldAnswers.push(() => socket.send(message))
              } else {
                socket.send(message)
              }
            })
          },
        )
      },
    })
    await shownText({
      page,
      chat: 'Hydra conversation',
      text: `answer ${EXCHANGES}`,
    })
    const conversation = page.getByRole(
      'region',
      { name: 'Hydra conversation' },
    )
    const loadedFirst = await conversation.locator('[data-entry-id]').first()
      .getAttribute('data-entry-id')
    const box = (await conversation.boundingBox())!
    await page.mouse.move(
      box.x + box.width / 2,
      box.y + box.height / 2,
    )
    // Up to the very top, where the browser's own scroll anchoring does not hold the rows on screen.
    const distance = await conversation.evaluate(chat => chat.scrollTop + chat.clientHeight)
    await page.mouse.wheel(
      0,
      -distance,
    )
    await until({
      what: 'the older page to be read',
      check: () => heldAnswers.length > 0,
    })
    await until({
      what: 'the reading position to paint',
      check: async () => (await framesOf({
        page,
        label: 'Hydra conversation',
      })).at(-1)!.fromBottom > 1,
    })
    const reading = (await framesOf({
      page,
      label: 'Hydra conversation',
    })).length - 1
    heldAnswers.splice(0).forEach(release => release())
    await until({
      what: 'older messages to load above',
      check: async () => (await framesOf({
        page,
        label: 'Hydra conversation',
      })).at(-1)!.first !== loadedFirst,
    })
    await nextFrames({
      page,
      count: SETTLING_FRAMES,
    })
    const frames = (await framesOf({
      page,
      label: 'Hydra conversation',
    })).slice(reading)
    const shared = Object.keys(frames[0]!.rows).filter(id => frames.at(-1)!.rows[id] !== undefined)
    expect(shared.length).toBeGreaterThan(0)
    expect(moves({ frames })).toEqual([])

    await page.getByRole(
      'button',
      { name: 'Jump to latest' },
    ).click()
    await nextFrames({
      page,
      count: ARRIVAL_FRAMES,
    })
    expect((await framesOf({
      page,
      label: 'Hydra conversation',
    })).at(-1)!.fromBottom).toBeLessThanOrEqual(1)
  },
)

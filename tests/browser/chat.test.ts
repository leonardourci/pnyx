import { beforeAll, expect, onTestFinished, test } from 'vitest'
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
const SETTLING_FRAMES = 10
const ARRIVAL_FRAMES = 2
const tallParagraph = ({ label }: { label: string }) => `${label}\n\n${'A line of the release notes that fills the width. '.repeat(6)}`

interface Frame {
  label: string | null
  fromBottom: number
  scrolls: boolean
  firstLoaded?: string
  shownFromBottom: Record<string, number>
}

function recordPaintedChats() {
  const frames: Frame[] = []
  Object.assign(
    window,
    { chatFrames: frames },
  )
  let changedSinceFrame = false
  new MutationObserver(() => {
    changedSinceFrame = true
  }).observe(
    document,
    {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    },
  )

  const samplePaintedFrame = () => {
    if (changedSinceFrame) {
      return
    }

    for (const chat of document.querySelectorAll<HTMLElement>('.chat-messages')) {
      const box = chat.getBoundingClientRect()
      const loaded = [...chat.querySelectorAll<HTMLElement>('[data-entry-id]')].flatMap(row => {
        const id = row.dataset.entryId

        return id === undefined ? [] : [
          {
            id,
            bounds: row.getBoundingClientRect(),
          },
        ]
      })
      const shown = loaded.filter(({ bounds }) => bounds.bottom > box.top
        && bounds.top < box.bottom)

      if (loaded.length) {
        frames.push({
          label: chat.getAttribute('aria-label'),
          fromBottom: chat.scrollHeight - chat.clientHeight - chat.scrollTop,
          scrolls: chat.scrollHeight > chat.clientHeight + 1,
          firstLoaded: loaded[0]?.id,
          shownFromBottom: Object.fromEntries(shown.map(({
            id,
            bounds,
          }) => [
            id,
            Math.round(box.bottom - bounds.bottom),
          ])),
        })
      }
    }
  }

  const afterPaint = new MessageChannel()
  afterPaint.port1.onmessage = samplePaintedFrame

  const frame = () => {
    changedSinceFrame = false
    afterPaint.port2.postMessage(null)
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

const latestFrame = async ({
  page,
  label,
}: {
  page: Page
  label: string
}) => {
  const latest = (await framesOf({
    page,
    label,
  })).at(-1)

  if (!latest) {
    throw new Error(`${label} painted no frame`)
  }

  return latest
}

const movedRows = ({ frames }: { frames: Frame[] }) => frames.slice(1).flatMap((
  frame,
  index,
) => Object.entries(frame.shownFromBottom)
  .filter(([
    id,
    offset,
  ]) => {
    const before = frames[index]?.shownFromBottom[id]

    return before !== undefined && Math.abs(before - offset) > 1
  })
  .map(([id]) => id))

const offEnd = ({ frames }: { frames: Frame[] }) => frames.map(frame => frame.fromBottom)
  .filter(distance => distance > 1)

test(
  'plain task ids, exact titles and card links open live task chips in both chats',
  async () => {
    const hydra = await pnyx.hydra()
    const { worker } = await hydra.startTask({ key: 'mentions' })
    const task = await hydra.task({ key: 'mentions' })
    const text = `Check ${task.id}, Task mentions and [the card](pnyx-task:${task.id}).`
    pnyx.claude.plan({
      hydra: hydra.id,
      text: 'Show the references',
      reply: text,
    })
    await hydra.chat({ text: 'Show the references' })
    await appendRecords({
      session: worker,
      records: [
        {
          type: 'assistant',
          content: text,
        },
      ],
    })
    const page = await openHydra({
      port: pnyx.port(),
      hydraId: hydra.id,
    })
    const hydraChat = page.getByRole(
      'region',
      { name: 'Hydra conversation' },
    )
    await hydraChat.getByText(
      'Check',
      { exact: false },
    ).waitFor()
    expect(await hydraChat.locator(`[data-task-ref="${task.id}"]`).count()).toBe(3)
    const copied = await hydraChat.evaluate(chat => {
      const paragraph = [...chat.querySelectorAll('p')].find(p => p.textContent?.startsWith('Check'))!
      const range = document.createRange()
      range.selectNodeContents(paragraph)
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      const clipboard = new DataTransfer()
      paragraph.dispatchEvent(new ClipboardEvent(
        'copy',
        {
          bubbles: true,
          cancelable: true,
          clipboardData: clipboard,
        },
      ))
      selection.removeAllRanges()

      return clipboard.getData('text/plain')
    })
    expect(copied).toBe(text)
    await hydraChat.locator(`[data-task-ref="${task.id}"]`).first()
      .click()
    const taskChat = page.getByRole(
      'region',
      { name: 'Task mentions conversation' },
    )
    await taskChat.getByText(
      'Check',
      { exact: false },
    ).waitFor()
    expect(await taskChat.locator(`[data-task-ref="${task.id}"]`).count()).toBe(3)
    expect(await taskChat.locator(`[data-task-ref="${task.id}"]`).first()
      .getAttribute('aria-label')).toContain('Task mentions;')
    await hydra.owner({
      args: [
        'task',
        'rename',
        task.id,
        '--title',
        'Renamed task',
      ],
    })
    await hydraChat.locator(`[data-task-ref="${task.id}"][aria-label^="Open task Renamed task;"]`)
      .first()
      .waitFor()
  },
)

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
    reply: tallParagraph({ label: `answer ${number}` }),
  })
  const session = await hydra.chat({ text: `question ${number}` })
  const turn = session.received.findLastIndex(text => text.includes(`question ${number}`))
  await until({
    what: `answer ${number}`,
    check: () => session.answered > turn,
  })
}

async function hydraWithLongConversation({ exchanges = EXCHANGES }: { exchanges?: number } = {}) {
  const hydra = await pnyx.hydra()

  for (let number = 1; number <= exchanges; number++) {
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
    content: tallParagraph({ label: `worker note ${from + index}` }),
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
    const hydra = await hydraWithLongConversation()
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
      beforeLoad: async ({ page }) => {
        await page.addInitScript(recordPaintedChats)
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
    expect(opened.at(-1)?.scrolls).toBe(true)
    expect(offEnd({ frames: opened })).toEqual([])
    expect(movedRows({ frames: opened })).toEqual([])

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
    expect(taskOpened.at(-1)?.scrolls).toBe(true)
    expect(offEnd({ frames: taskOpened })).toEqual([])
    expect(movedRows({ frames: taskOpened })).toEqual([])
    const heights = await card.evaluate(element => {
      const column = element.closest<HTMLElement>('.column-cards')

      if (!column) {
        throw new Error('The open card sits in no column')
      }

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
        page.locator('.hydra-chat').getByRole(
          'status',
          { name: /^Running(?:\.|$)/ },
        ),
        page.locator('[data-task]').getByRole(
          'status',
          { name: /^Running(?:\.|$)/ },
        ),
      ]

      for (const line of working) {
        await line.getByText('Running a command').waitFor()
      }

      await page.locator('[data-task] .agent-activity').focus()
      expect(await page.getByRole('tooltip').textContent()).toBe('running')

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
  'reading back, older messages load above the ones on screen without moving them, a failed load says why and Retry reads it again, and Jump returns to the latest',
  async () => {
    const hydra = await hydraWithLongConversation({ exchanges: 32 })
    const { worker } = await hydra.startTask({ key: 'older-notes' })
    await appendRecords({
      session: worker,
      records: workerNotes({
        from: 1,
        count: 190,
      }),
    })
    let refusedFirstOlderRead = false
    const olderReads = new Set<string>()
    const heldOlderAnswers: (() => void)[] = []
    const page = await openHydra({
      port: pnyx.port(),
      hydraId: hydra.id,
      reducedMotion: true,
      beforeLoad: async ({ page }) => {
        await page.addInitScript(recordPaintedChats)
        await page.routeWebSocket(
          /\/ws(\?|$)/,
          socket => {
            const server = socket.connectToServer()
            socket.onMessage(message => {
              const sent = JSON.parse(String(message)) as {
                scope?: string
                id: string
                name?: string
                args?: string[]
              }
              const cursor = sent.args?.length === 2 ? sent.args[1] : undefined
              const olderRead = sent.name === 'thread' && cursor !== undefined && !cursor.startsWith('--')

              if (olderRead && !refusedFirstOlderRead) {
                refusedFirstOlderRead = true
                socket.send(JSON.stringify({
                  type: 'error',
                  scope: sent.scope,
                  id: sent.id,
                  code: 'THREAD_UNAVAILABLE',
                  error: 'The transcript is unavailable',
                }))

                return
              }

              if (olderRead) {
                olderReads.add(sent.id)
              }

              server.send(message)
            })
            server.onMessage(message => {
              const answer = JSON.parse(String(message)) as { id?: string }

              if (answer.id !== undefined && olderReads.has(answer.id)) {
                heldOlderAnswers.push(() => socket.send(message))
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
      text: 'answer 32',
    })

    for (const label of [
      'Hydra conversation',
      'Task older-notes conversation',
    ]) {
      if (label === 'Task older-notes conversation') {
        await page.locator('[data-task]').getByText(
          'Task older-notes',
          { exact: true },
        )
          .click()
        await shownText({
          page,
          chat: label,
          text: 'worker note 190',
        })
      }

      const conversation = page.getByRole(
        'region',
        { name: label },
      )

      for (let olderPage = 0; olderPage < 3; olderPage++) {
        const loadedFirst = await conversation.locator('[data-entry-id]').first()
          .getAttribute('data-entry-id')
        await conversation.hover()
        const pastTheTop = await conversation.evaluate(chat => chat.scrollTop + chat.clientHeight)
        await page.mouse.wheel(
          0,
          -pastTheTop,
        )

        if (label === 'Hydra conversation' && olderPage === 0) {
          await conversation.getByRole('alert').filter({ hasText: 'Earlier messages did not load: The transcript is unavailable' })
            .getByRole(
              'button',
              { name: 'Retry' },
            )
            .click()
        }

        await until({
          what: 'the older page response',
          check: () => heldOlderAnswers.length > 0,
        })
        await nextFrames({
          page,
          count: ARRIVAL_FRAMES,
        })
        const reading = (await framesOf({
          page,
          label,
        })).length - 1
        // eslint-disable-next-line pnyx/object-params -- Playwright owns this element callback.
        const anchor = await conversation.evaluateHandle(chat => {
          const top = chat.getBoundingClientRect().top

          return [...chat.querySelectorAll('[data-entry-id]')].find(row => row.getBoundingClientRect().bottom > top)
        })
        heldOlderAnswers.splice(0).forEach(release => release())
        await until({
          what: 'older messages above the reading position',
          check: async () => (await latestFrame({
            page,
            label,
          })).firstLoaded !== loadedFirst,
        })
        await nextFrames({
          page,
          count: SETTLING_FRAMES,
        })
        const frames = (await framesOf({
          page,
          label,
        })).slice(reading)
        const [readingFrame] = frames
        const settledFrame = frames.at(-1)
        const stillShown = Object.keys(readingFrame?.shownFromBottom ?? {})
          .filter(id => settledFrame?.shownFromBottom[id] !== undefined)
        expect(stillShown.length).toBeGreaterThan(0)
        expect(
          movedRows({ frames }),
          JSON.stringify(frames),
        ).toEqual([])
        expect(frames.every(frame => Object.keys(frame.shownFromBottom).length > 0)).toBe(true)
        expect(await anchor.evaluate(row => row?.isConnected)).toBe(true)
        await anchor.dispose()
      }

      expect(await conversation.getByText('The transcript is unavailable').count()).toBe(0)
      await conversation.locator('..').getByRole(
        'button',
        { name: 'Jump to latest' },
      )
        .click()
      await nextFrames({
        page,
        count: ARRIVAL_FRAMES,
      })
      expect((await latestFrame({
        page,
        label,
      })).fromBottom).toBeLessThanOrEqual(1)
    }
  },
)

test.each([
  { target: 'Hydra' },
  { target: 'worker' },
] as const)(
  'a $target sent message stays as one owner row while held and through its answer',
  async ({ target }) => {
    const hydra = await pnyx.hydra()
    const { worker } = await hydra.startTask({ key: 'lakes' })
    const compact = pnyx.claude.plan({
      hydra: hydra.id,
      text: '/compact',
      compacting: true,
      hold: true,
    })
    onTestFinished(() => compact.release())
    const session = target === 'Hydra' ? await hydra.chat({ text: '/compact' }) : worker
    const label = target === 'Hydra' ? 'Hydra conversation' : 'Task lakes conversation'
    const field = target === 'Hydra' ? 'Reply to Hydra' : 'Message worker'
    const answer = pnyx.claude.plan({
      hydra: hydra.id,
      match: ({ text }) => text.includes('List three lakes'),
      reply: 'Titicaca, Baikal and Victoria.',
      hold: true,
    })
    onTestFinished(() => answer.release())
    const page = await openHydra({
      port: pnyx.port(),
      hydraId: hydra.id,
      reducedMotion: true,
    })

    if (target === 'worker') {
      await page.locator('[data-task]').getByText(
        'Task lakes',
        { exact: true },
      )
        .click()
    }

    const chat = page.getByRole(
      'region',
      { name: label },
    )
    await chat.waitFor()
    await page.evaluate(
      ({ label }) => {
        const counts: number[] = []
        Object.assign(
          window,
          { ownerRows: counts },
        )

        const frame = () => {
          const chat = document.querySelector(`[aria-label="${label}"]`)
          const rows = [...chat?.querySelectorAll('[data-entry-id][aria-label="You"]') ?? []]
          counts.push(rows.filter(row => row.textContent?.includes('List three lakes')).length)
          requestAnimationFrame(frame)
        }

        requestAnimationFrame(frame)
      },
      { label },
    )
    await page.getByRole(
      'textbox',
      { name: field },
    ).fill('List three lakes')
    await page.keyboard.press('Enter')
    await chat.getByText(
      'List three lakes',
      { exact: true },
    ).waitFor()
    await nextFrames({
      page,
      count: SETTLING_FRAMES,
    })
    compact.release()
    await until({
      what: 'the agent to take the message',
      check: () => session.received.some(text => text.includes('List three lakes')),
    })
    expect(await page.getByRole(
      'region',
      { name: label },
    ).locator('[data-entry-id][aria-label="You"]')
      .filter({ hasText: 'List three lakes' })
      .count()).toBe(1)
    answer.release()
    await chat.getByText('Titicaca, Baikal and Victoria.').filter({ visible: true })
      .waitFor()
    await nextFrames({
      page,
      count: ARRIVAL_FRAMES,
    })
    const counts = await page.evaluate(() => (window as unknown as { ownerRows: number[] })
      .ownerRows)
    const sent = counts.findIndex(count => count > 0)
    expect(sent).toBeGreaterThanOrEqual(0)
    expect(new Set(counts.slice(sent))).toEqual(new Set([1]))
  },
)

test.each([
  { harness: 'claude' },
  { harness: 'codex' },
] as const)(
  '$harness sends in either chat interrupt the turn and Stop adds no conversation text',
  async ({ harness }) => {
    const hydra = await pnyx.hydra()
    const { worker } = await hydra.startTask({
      key: 'interrupt',
      harness,
    })
    const socket = await hydra.page()
    await socket.send({
      name: 'hydra-agent',
      args: [JSON.stringify({ harness })],
    })
    socket.close()
    const turn = pnyx[harness].plan({
      hydra: hydra.id,
      text: 'Keep working',
      partial: 'Working on it',
      hold: true,
    })
    const hydraSession = await hydra.chat({ text: 'Keep working' })
    const workerTurn = pnyx[harness].plan({
      hydra: hydra.id,
      match: ({ text }) => text.includes('Keep working too'),
      partial: 'Working too',
      hold: true,
    })
    await hydra.owner({
      args: [
        'task',
        'send',
        'interrupt',
        '--harness',
        harness,
        '--text',
        'Keep working too',
      ],
    })
    onTestFinished(() => {
      turn.release(); workerTurn.release()
    })
    const page = await openHydra({
      port: pnyx.port(),
      hydraId: hydra.id,
      reducedMotion: true,
    })
    await page.locator('[data-task]').getByText(
      'Task interrupt',
      { exact: true },
    )
      .click()

    for (const [
      field,
      chat,
      session,
      text,
      stop,
    ] of [
        [
          'Reply to Hydra',
          'Hydra conversation',
          hydraSession,
          'Answer this instead',
          'Stop Hydra',
        ],
        [
          'Message worker',
          'Task interrupt conversation',
          worker,
          'Answer this too',
          'Stop worker',
        ],
      ] as const) {
      const nextTurn = pnyx[harness].plan({
        hydra: hydra.id,
        match: ({ text: input }) => input.includes(text),
        partial: 'New reply',
        reply: 'Must not finish after Stop',
        hold: true,
      })
      onTestFinished(() => nextTurn.release())
      const conversation = page.getByRole(
        'region',
        { name: chat },
      )
      await page.getByRole(
        'textbox',
        {
          name: field,
          exact: true,
        },
      ).fill(text)
      await page.keyboard.press('Enter')
      await until({
        what: 'the new input to reach the interrupted session',
        check: () => session.received.some(input => input.includes(text)),
      })
      await conversation.getByText(
        text,
        { exact: true },
      ).waitFor()
      await nextFrames({
        page,
        count: ARRIVAL_FRAMES,
      })
      expect(await conversation.getByRole(
        'button',
        { name: 'Send now' },
      ).count()).toBe(0)
      expect(await conversation.locator('[aria-label="You"]').filter({ hasText: text })
        .count()).toBe(1)
      const rows = await conversation.locator('[data-entry-id]').count()
      await page.getByRole(
        'button',
        {
          name: stop,
          exact: true,
        },
      ).click()
      await until({
        what: 'the stopped turn to end',
        check: () => session.answered === session.received.length,
      })
      await nextFrames({
        page,
        count: SETTLING_FRAMES,
      })
      expect(await conversation.locator('[data-entry-id]').count()).toBe(rows)
      expect(await conversation.locator('.chat-error').count()).toBe(0)
      expect(await conversation.getByText('Must not finish after Stop').count()).toBe(0)
      expect(await conversation.locator('[aria-label="You"]').filter({ hasText: text })
        .count()).toBe(1)
    }
  },
)

test.each([
  { target: 'Hydra' },
  { target: 'worker' },
])(
  'a refused $target send shows its error on the same bubble and Retry delivers the same id once',
  async ({ target }) => {
    const hydra = await pnyx.hydra()
    await hydra.startTask({
      key: 'retry-input',
      harness: 'codex',
    })
    const socket = await hydra.page()
    await socket.send({
      name: 'hydra-agent',
      args: [JSON.stringify({ harness: 'codex' })],
    })
    socket.close()
    const text = `Retry the ${target} input`

    if (target === 'Hydra') {
      const turn = pnyx.codex.plan({
        hydra: hydra.id,
        text: 'Keep working before refusal',
        hold: true,
      })
      onTestFinished(() => turn.release())
      await hydra.chat({ text: 'Keep working before refusal' })
      pnyx.codex.refuseNextInterrupt()
    } else {
      pnyx.codex.plan({
        hydra: hydra.id,
        match: ({ text: input }) => input.includes(text),
        refuse: true,
      })
    }

    const page = await openHydra({
      port: pnyx.port(),
      hydraId: hydra.id,
      reducedMotion: true,
    })

    if (target === 'worker') {
      await page.locator('[data-task]').getByText(
        'Task retry-input',
        { exact: true },
      )
        .click()
    }

    const label = target === 'Hydra' ? 'Hydra conversation' : 'Task retry-input conversation'
    const field = target === 'Hydra' ? 'Reply to Hydra' : 'Message worker'
    const conversation = page.getByRole(
      'region',
      { name: label },
    )
    await page.getByRole(
      'textbox',
      {
        name: field,
        exact: true,
      },
    ).fill(text)
    await page.keyboard.press('Enter')
    const row = conversation.locator('.message-row').filter({ hasText: text })
    await row.getByRole(
      'button',
      {
        name: 'Retry',
        exact: true,
      },
    ).waitFor()
    expect(await row.getByRole('alert').textContent()).toContain('refused')
    const id = await row.locator('[data-entry-id]').getAttribute('data-entry-id')

    if (target === 'Hydra') {
      await pnyx.restart()
      await row.getByRole(
        'button',
        {
          name: 'Retry',
          exact: true,
        },
      ).waitFor()
      expect(await row.getByRole('alert').textContent()).toContain('refused')
    }

    await row.getByRole(
      'button',
      {
        name: 'Retry',
        exact: true,
      },
    ).click()
    await until({
      what: 'the second attempt to finish after the one-shot refusal',
      check: () => pnyx.codex.sessions.some(session => {
        const received = session.received.some(input => input.includes(text))

        return received && session.answered === session.received.length
      }),
    })
    await conversation.getByText(
      'Recorded reply.',
      { exact: true },
    )
      .first()
      .waitFor()
    const attempts = pnyx.codex.sessions.flatMap(session => session.received)
      .filter(input => input.includes(text))
    expect(attempts).toHaveLength(target === 'Hydra' ? 1 : 2)
    expect(await row.count()).toBe(1)
    expect(await row.locator('[data-entry-id]').getAttribute('data-entry-id')).toBe(id)
    expect(await row.getByRole('alert').count()).toBe(0)
    expect(await row.locator('.receipt').count()).toBe(0)
    expect(await row.locator('time').count()).toBe(1)
  },
)

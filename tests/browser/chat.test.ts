import { beforeAll, expect, onTestFinished, test, vi } from 'vitest'
import type { Page } from 'playwright-core'
import { startOthrys, until, type Titan, type Othrys } from '../setup/othrys.ts'
import { appendRecords } from '../setup/transcripts.ts'
import { TITAN_CARD } from '#titan/identity.ts'
import { openTitan } from './page.ts'

let othrys: Othrys

beforeAll(async () => {
  othrys = await startOthrys()
})

const EXCHANGES = 12
const WORKER_MESSAGES = 40
const SETTLING_FRAMES = 10
const ARRIVAL_FRAMES = 2
const SHORT_VIEWPORT_HEIGHT = 600
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

    for (const chat of document.querySelectorAll<HTMLElement>('[data-hydra-workspace][data-active=true] .chat-messages')) {
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
    const hydra = await othrys.hydra()
    const { worker } = await hydra.startTask({ key: 'mentions' })
    const task = await hydra.task({ key: 'mentions' })
    const prose = `Check ${task.id}, Task mentions and [the card](othrys-task:${task.id}).`
    const text = `${prose}\n\n\`Task mentions\`\n\n\`\`\`\n${task.id}\n\`\`\``
    othrys.claude.plan({
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
    const page = await openTitan({
      port: othrys.port(),
      hydraId: hydra.id,
      beforeLoad: async ({ page }) => {
        await page.setViewportSize({
          ...page.viewportSize()!,
          height: SHORT_VIEWPORT_HEIGHT,
        })
      },
    })
    const hydraChat = page.locator('[data-hydra-workspace][data-active=true]').getByRole(
      'region',
      { name: 'Titan conversation' },
    )
    await hydraChat.getByText(
      'Check',
      { exact: false },
    ).waitFor()
    expect(await hydraChat.locator(`[data-task-ref="${task.id}"]`).count()).toBe(3)
    const unmatched = 'Send this @zzzznomatchingtaskzzzz'
    othrys.claude.plan({
      hydra: hydra.id,
      text: unmatched,
      reply: 'Received the unmatched reference.',
    })
    const composer = page.locator('[data-hydra-workspace][data-active=true]').getByRole(
      'textbox',
      {
        name: 'Reply to Titan',
        exact: true,
      },
    )
    const draft = 'Keep this draft when Enter repeats'
    await composer.fill(draft)
    await composer.dispatchEvent(
      'keydown',
      {
        key: 'Enter',
        repeat: true,
      },
    )
    expect(await composer.inputValue()).toBe(draft)
    await composer.dispatchEvent(
      'keydown',
      {
        key: 'Enter',
        keyCode: 229,
      },
    )
    expect(await composer.inputValue()).toBe(draft)
    await composer.fill(unmatched)
    await page.getByText(
      'Nothing in this Titan matches.',
      { exact: true },
    ).waitFor()
    await page.keyboard.press('Enter')
    await hydraChat.getByText(
      unmatched,
      { exact: true },
    ).waitFor()
    expect(await composer.inputValue()).toBe('')
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
    expect(copied).toBe(prose)
    await hydraChat.getByText(
      'Received the unmatched reference.',
      { exact: true },
    ).waitFor()
    await hydraChat.evaluate(async chat => {
      const messages = chat.querySelector<HTMLElement>('.messages')!
      const chip = messages.querySelector<HTMLElement>('[data-task-ref]')!
      messages.focus({ preventScroll: true })
      const fromEnd = chip.getBoundingClientRect().height
      const end = chat.scrollHeight - chat.clientHeight

      if (end <= fromEnd) {
        throw new Error('The conversation must scroll to exercise focus transfer')
      }

      const readingPosition = end - fromEnd

      if (chat.scrollTop === readingPosition) {
        return
      }

      await new Promise<void>(resolve => {
        chat.addEventListener(
          'scroll',
          () => resolve(),
          { once: true },
        )
        chat.scrollTop = readingPosition
      })
    })
    await hydraChat.locator(`[data-task-ref="${task.id}"]`).first()
      .click()
    const taskChat = page.locator('[data-hydra-workspace][data-active=true]').getByRole(
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
}) => page.locator('[data-hydra-workspace][data-active=true]').getByRole(
  'region',
  { name: chat },
)
  .getByText(text)
  .filter({ visible: true })
  .waitFor()

const exchange = async ({
  hydra,
  number,
}: {
  hydra: Titan
  number: number
}) => {
  othrys.claude.plan({
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

async function hydraWithLongConversation({
  exchanges = EXCHANGES,
  tieLast = false,
}: {
  exchanges?: number
  tieLast?: boolean
} = {}) {
  const hydra = await othrys.hydra()

  for (let number = 1; number <= exchanges; number++) {
    if (tieLast && number === exchanges) {
      vi.useFakeTimers({ toFake: ['Date'] })
    }

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
  hydra: Titan
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
  'Titan\'s chat and a task\'s chat open on their latest row, hold still and keep the end in view as rows arrive, in a card as tall as its column',
  async () => {
    onTestFinished(() => {
      vi.useRealTimers()
    })
    const hydra = await hydraWithLongConversation({ tieLast: true })
    const { worker } = await hydra.startTask({ key: 'notes' })
    await appendRecords({
      session: worker,
      records: workerNotes({
        from: 1,
        count: WORKER_MESSAGES,
      }),
    })

    const page = await openTitan({
      port: othrys.port(),
      hydraId: hydra.id,
      reducedMotion: true,
      beforeLoad: async ({ page }) => {
        await page.addInitScript(recordPaintedChats)
      },
    })
    await shownText({
      page,
      chat: 'Titan conversation',
      text: `answer ${EXCHANGES}`,
    })
    vi.useRealTimers()
    await nextFrames({
      page,
      count: SETTLING_FRAMES,
    })
    const opened = await framesOf({
      page,
      label: 'Titan conversation',
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
      chat: 'Titan conversation',
      text: `answer ${EXCHANGES + 1}`,
    })
    await nextFrames({
      page,
      count: ARRIVAL_FRAMES,
    })
    expect(offEnd({
      frames: await framesOf({
        page,
        label: 'Titan conversation',
      }),
    })).toEqual([])

    const card = page.locator('[data-hydra-workspace][data-active=true] [data-task]').filter({ hasText: 'Task notes' })
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
  'plain send and answer calls and saved legacy calls show their action and live task links',
  async () => {
    const hydra = await othrys.hydra()
    await hydra.startTask({ key: 'labels' })
    const task = await hydra.task({ key: 'labels' })
    await setFocusMode({
      hydra,
      on: false,
    })
    const page = await openTitan({
      port: othrys.port(),
      hydraId: hydra.id,
    })

    try {
      await page.goto(`http://127.0.0.1:${othrys.port()}/hydra/${hydra.id}/settings/`)
      await expect.poll(
        () => page.getByRole(
          'switch',
          {
            name: 'Focus mode',
            exact: true,
          },
        ).getAttribute('aria-checked'),
      ).toBe('false')
      await page.goto(`http://127.0.0.1:${othrys.port()}/hydra/${hydra.id}/`)
      const session = await hydra.chat({ text: 'Review the work' })
      await until({
        what: 'Titan to finish its first reply',
        check: () => session.answered === session.received.length,
      })
      await appendRecords({
        session,
        records: [
          {
            type: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_status',
                name: 'Bash',
                input: { command: 'git status' },
              },
            ],
          },
          {
            type: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_status',
                content: 'clean',
              },
            ],
          },
          {
            type: 'assistant',
            content: [
              {
                type: 'text',
                text: 'Checked the repository status.',
              },
            ],
          },
          ...[
            {
              id: 'toolu_send',
              command: `othrys send --task ${task.id} --text "Check it"`,
            },
            {
              id: 'toolu_answer',
              command: `othrys answer ${task.id} question-1 --text "Use it"`,
            },
            {
              id: 'toolu_legacy',
              command: `othrys-axi reply ${task.id} --text "Earlier call"`,
            },
            {
              id: 'toolu_file',
              command: `othrys send --task ${task.id} --file message.txt`,
            },
          ].flatMap(({
            id,
            command,
          }) => [
            {
              type: 'assistant' as const,
              content: [
                {
                  type: 'tool_use',
                  id,
                  name: 'Bash',
                  input: { command },
                },
              ],
            },
            {
              type: 'user' as const,
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: id,
                  content: 'ok',
                },
              ],
            },
          ]),
        ],
      })
      const conversation = page.locator(`[data-hydra-workspace="${hydra.id}"]`).getByRole(
        'region',
        { name: 'Titan conversation' },
      )
      const progress = conversation.locator('.turn-actions > .disclosure').filter({
        has: page.locator('.trace-label').getByRole(
          'button',
          {
            name: /^Open task Task labels;/,
            includeHidden: true,
          },
        ),
      })
      const traces = progress.locator('[data-progress-kind="tool"]')
      const labels = traces.locator('.trace-label')
      await progress.locator(':scope > summary').click()
      await expect.poll(() => labels.filter({ hasText: /^Sending/ }).count()).toBe(3)
      await expect.poll(() => traces.filter({ hasText: 'message.txt' }).locator('.trace-label')
        .textContent()).toMatch(/’s worker$/)
      await expect.poll(() => labels.filter({ hasText: /^Answering the question from/ }).count()).toBe(1)
      await expect.poll(() => traces.getByRole(
        'button',
        { name: /^Open task Task labels;/ },
      ).count()).toBe(4)
      await labels.filter({ hasText: /^Answering the question from/ }).getByRole(
        'button',
        { name: /^Open task Task labels;/ },
      )
        .click()
      await expect.poll(() => page.locator(`[data-task="${task.id}"] .card-open`).getAttribute('aria-expanded')).toBe('true')
    } finally {
      await setFocusMode({
        hydra,
        on: true,
      })
    }
  },
)

test(
  'with Focus mode on, a running tool call is named in neither Titan\'s nor a task\'s working line, and a card\'s status never names one',
  async () => {
    const hydra = await othrys.hydra()
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
    const hydraTurn = othrys.claude.plan({
      hydra: hydra.id,
      text: 'Check the build',
      reply: 'The build passes.',
      tool: build({ id: 'toolu_hydra_build' }),
      hold: true,
    })
    const workerTurn = othrys.claude.plan({
      hydra: hydra.id,
      match: ({ text }) => text.includes('Run the build'),
      reply: 'Built.',
      tool: build({ id: 'toolu_worker_build' }),
      hold: true,
    })

    try {
      const page = await openTitan({
        port: othrys.port(),
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
      await page.locator('[data-hydra-workspace][data-active=true] [data-task]').getByText(
        'Task build',
        { exact: true },
      )
        .click()
      const working = [
        page.locator('[data-hydra-workspace][data-active=true] .hydra-chat .chat-running-status'),
        page.locator('[data-hydra-workspace][data-active=true] [data-task] .chat-running-status'),
      ]

      for (const line of working) {
        await line.getByText('Running a command').waitFor()
      }

      const activeTask = page.locator('[data-hydra-workspace][data-active=true] [data-task]')
      const status = activeTask.locator('.agent-activity')
      const toolDetails = /Running a command|Bash|pnpm build/
      expect(await status.textContent() ?? '').not.toMatch(toolDetails)
      expect(await status.getAttribute('aria-label') ?? '').not.toMatch(toolDetails)

      await setFocusMode({
        hydra,
        on: true,
      })
      await until({
        what: 'both working lines to stop naming the tool',
        check: async () => {
          const labelsOnly = await Promise.all(working.map(async line => {
            const text = await line.textContent()
            const labelVisible = await line.getByText(
              'Working',
              { exact: true },
            ).isVisible()

            return labelVisible && text !== null && !text.includes('Running a command')
          }))

          return labelsOnly.every(Boolean)
        },
      })
      expect(await status.textContent() ?? '').not.toMatch(toolDetails)
      expect(await status.getAttribute('aria-label') ?? '').not.toMatch(toolDetails)
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
    onTestFinished(() => {
      vi.useRealTimers()
    })
    const hydra = await hydraWithLongConversation({
      tieLast: true,
      exchanges: 32,
    })
    const hydraSession = othrys.claude.sessions.findLast(session =>
      session.env.OTHRYS_TITAN === hydra.id)!
    const { worker } = await hydra.startTask({ key: 'older-notes' })
    const card = await hydra.task({ key: 'older-notes' })
    await appendRecords({
      session: worker,
      records: workerNotes({
        from: 1,
        count: 190,
      }),
    })
    let refusedFirstOlderRead = false
    let dropCard: string | undefined
    let dropped = false
    let resyncs = 0
    const epochs = new Map<string, string>()
    const olderReads = new Set<string>()
    const heldOlderAnswers: (() => void)[] = []
    const page = await openTitan({
      port: othrys.port(),
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
                type?: string
                scope?: string
                id: string
                name?: string
                args?: string[]
              }

              if (sent.type === 'resync') {
                resyncs++
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
              const answer = JSON.parse(String(message)) as {
                id?: string
                type?: string
                thread?: {
                  card: string
                  epoch?: string
                }
                delta?: {
                  page: {
                    card: string
                    epoch?: string
                  }
                }
              }
              const frame = answer.thread ?? answer.delta?.page

              if (frame?.epoch) {
                epochs.set(
                  frame.card,
                  frame.epoch,
                )
              }

              if (answer.type === 'thread.delta' && answer.delta?.page.card === dropCard) {
                dropCard = undefined
                dropped = true

                return
              }

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
      chat: 'Titan conversation',
      text: 'answer 32',
    })
    vi.useRealTimers()

    for (const label of [
      'Titan conversation',
      'Task older-notes conversation',
    ]) {
      if (label === 'Task older-notes conversation') {
        await page.locator('[data-hydra-workspace][data-active=true] [data-task]').getByText(
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

      const conversation = page.locator('[data-hydra-workspace][data-active=true]').getByRole(
        'region',
        { name: label },
      )

      let totalMovement = 0

      for (let olderPage = 0; olderPage < 3; olderPage++) {
        const loadedFirst = await conversation.locator('[data-entry-id]').first()
          .getAttribute('data-entry-id')
        await conversation.hover()
        const pastTheTop = await conversation.evaluate(chat => chat.scrollTop + chat.clientHeight)
        await page.mouse.wheel(
          0,
          -pastTheTop,
        )

        if (label === 'Titan conversation' && olderPage === 0) {
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

        if (olderPage === 0) {
          await conversation.locator('..').getByRole(
            'button',
            { name: 'Jump to latest' },
          )
            .click()
          await conversation.evaluate(chat => {
            chat.scrollTop = 0
            const row = chat.querySelector('[data-entry-id]')

            if (!row) {
              throw new Error('No message to select')
            }

            const range = document.createRange()
            range.selectNodeContents(row)
            window.getSelection()?.removeAllRanges()
            window.getSelection()?.addRange(range)
            document.dispatchEvent(new Event('selectionchange'))
          })
        }

        await nextFrames({
          page,
          count: ARRIVAL_FRAMES,
        })
        const reading = (await framesOf({
          page,
          label,
        })).length - 1
        const anchorId = await conversation.evaluate(chat => {
          const top = chat.getBoundingClientRect().top
          const firstVisible = [...chat.querySelectorAll<HTMLElement>('[data-entry-id]')]
            .find(row => row.getBoundingClientRect().bottom > top)

          return firstVisible?.dataset.entryId
        })

        if (!anchorId) {
          throw new Error('No visible message before loading older history')
        }

        const anchor = conversation.locator(`[data-entry-id="${anchorId}"]`)
        const anchorBefore = await anchor.evaluate(row => row.getBoundingClientRect().top)
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
        expect(
          movedRows({ frames }),
          JSON.stringify(frames),
        ).toEqual([])
        expect(frames.length).toBeGreaterThan(0)
        expect(frames.every(frame => frame.shownFromBottom[anchorId] !== undefined)).toBe(true)
        const anchorAfter = await anchor.evaluate(row => row.getBoundingClientRect().top)
        const movement = anchorAfter - anchorBefore
        totalMovement += movement
        // scrollTop rounds fractional geometry; total drift stays within one pixel across prepends.
        expect(Math.abs(totalMovement)).toBeLessThanOrEqual(1)

        if (olderPage === 0) {
          await page.evaluate(() => {
            window.getSelection()?.removeAllRanges()

            if (document.activeElement instanceof HTMLElement) {
              document.activeElement.blur()
            }
          })
        }
      }

      const readingAnchor = await conversation.evaluateHandle(({ firstElementChild }) => {
        const chat = firstElementChild?.parentElement

        if (!chat) {
          throw new Error('Conversation has no rows')
        }

        const top = chat.getBoundingClientRect().top

        const row = [...chat.querySelectorAll<HTMLElement>('[data-entry-id]')]
          .find(row => row.getBoundingClientRect().bottom > top)

        if (!row) {
          throw new Error('Conversation has no visible reading anchor')
        }

        return row
      })
      const anchorBeforeRecovery = await readingAnchor.evaluate(row => {
        const chat = row.closest('.chat-messages')!

        return row.getBoundingClientRect().top - chat.getBoundingClientRect().top
      })
      const loadedRows = await conversation.locator('[data-entry-id]').count()
      const session = label === 'Titan conversation' ? hydraSession : worker
      const priorResyncs = resyncs
      dropped = false
      dropCard = label === 'Titan conversation' ? TITAN_CARD : card.id
      await appendRecords({
        session,
        records: [
          {
            type: 'assistant',
            content: 'Reply in a dropped patch',
          },
        ],
      })
      await until({
        what: 'the deliberately dropped chat delta',
        check: () => dropped,
      })
      await appendRecords({
        session,
        records: [
          {
            type: 'assistant',
            content: 'Reply after the dropped patch',
          },
        ],
      })
      await until({
        what: 'the complete native reply recovered across the gap',
        check: async () => resyncs > priorResyncs
          && await conversation.getByText(
            'Reply in a dropped patch',
            { exact: true },
          ).count() === 1
          && await conversation.getByText(
            'Reply after the dropped patch',
            { exact: true },
          ).count() === 1,
      })
      expect(await readingAnchor.evaluate(row => row.isConnected)).toBe(true)
      expect(await conversation.locator('[data-entry-id]').count()).toBeGreaterThanOrEqual(loadedRows)
      expect(Math.abs(
        await readingAnchor.evaluate(row => {
          const chat = row.closest('.chat-messages')!

          return row.getBoundingClientRect().top - chat.getBoundingClientRect().top
        }) - anchorBeforeRecovery,
      ))
        .toBeLessThanOrEqual(1)
      const recoveringCard = label === 'Titan conversation' ? TITAN_CARD : card.id
      const beforeEpoch = epochs.get(recoveringCard)
      expect(beforeEpoch).toBeDefined()
      await othrys.restart()
      await appendRecords({
        session,
        records: [
          {
            type: 'assistant',
            content: 'Reply written after daemon restart',
          },
        ],
      })
      await until({
        what: 'the retained chat range after a new daemon epoch',
        check: async () => {
          const epoch = epochs.get(recoveringCard)

          if (epoch === undefined || epoch === beforeEpoch) {
            return false
          }

          return await conversation.getByText(
            'Reply written after daemon restart',
            { exact: true },
          ).count() === 1 && await conversation.getByText(
            'Reply in a dropped patch',
            { exact: true },
          ).count() === 1 && await conversation.getByText(
            'Reply after the dropped patch',
            { exact: true },
          ).count() === 1 && await conversation.locator('[data-entry-id]').count() >= loadedRows
        },
      })
      expect(await readingAnchor.evaluate(row => row.isConnected)).toBe(true)
      expect(Math.abs(
        await readingAnchor.evaluate(row => {
          const chat = row.closest('.chat-messages')!

          return row.getBoundingClientRect().top - chat.getBoundingClientRect().top
        }) - anchorBeforeRecovery,
      ))
        .toBeLessThanOrEqual(1)

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
  { target: 'Titan' },
  { target: 'worker' },
] as const)(
  'a $target sent message stays as one owner row while held and through its answer',
  async ({ target }) => {
    const hydra = await othrys.hydra()
    const { worker } = await hydra.startTask({ key: 'lakes' })
    const compact = othrys.claude.plan({
      hydra: hydra.id,
      text: '/compact',
      compacting: true,
      hold: true,
    })
    onTestFinished(() => compact.release())
    let session = worker

    if (target === 'Titan') {
      session = await hydra.chat({ text: '/compact' })
    } else {
      await hydra.owner({
        args: [
          'reply',
          'lakes',
          '--text',
          '/compact',
        ],
      })
      await until({
        what: 'the worker to begin compaction',
        check: () => worker.received.some(text => text.endsWith('/compact')),
      })
    }

    const label = target === 'Titan' ? 'Titan conversation' : 'Task lakes conversation'
    const field = target === 'Titan' ? 'Reply to Titan' : 'Message worker'
    const answer = othrys.claude.plan({
      hydra: hydra.id,
      match: ({ text }) => text.includes('List three lakes'),
      reply: 'Titicaca, Baikal and Victoria.',
      hold: true,
    })
    onTestFinished(() => answer.release())
    const page = await openTitan({
      port: othrys.port(),
      hydraId: hydra.id,
      reducedMotion: true,
    })

    if (target === 'worker') {
      await page.locator('[data-hydra-workspace][data-active=true] [data-task]').getByText(
        'Task lakes',
        { exact: true },
      )
        .click()
    }

    const chat = page.locator('[data-hydra-workspace][data-active=true]').getByRole(
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
          const chat = document.querySelector(`[data-hydra-workspace][data-active=true] [aria-label="${label}"]`)
          const rows = [...chat?.querySelectorAll('[data-entry-id][aria-label="You"]') ?? []]
          counts.push(rows.filter(row => row.textContent?.includes('List three lakes')).length)
          requestAnimationFrame(frame)
        }

        requestAnimationFrame(frame)
      },
      { label },
    )
    await page.locator('[data-hydra-workspace][data-active=true]').getByRole(
      'textbox',
      { name: field },
    )
      .fill('List three lakes')
    await page.keyboard.press('Enter')
    await chat.getByText(
      'List three lakes',
      { exact: true },
    ).waitFor()
    await nextFrames({
      page,
      count: SETTLING_FRAMES,
    })
    expect(session.received.some(text => text.includes('List three lakes'))).toBe(false)
    compact.release()
    await until({
      what: 'the agent to take the message',
      check: () => session.received.some(text => text.includes('List three lakes')),
    })
    expect(await page.locator('[data-hydra-workspace][data-active=true]').getByRole(
      'region',
      { name: label },
    )
      .locator('[data-entry-id][aria-label="You"]')
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
    const hydra = await othrys.hydra()
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
    const turn = othrys[harness].plan({
      hydra: hydra.id,
      text: 'Keep working',
      partial: 'Working on it',
      hold: true,
    })
    const hydraSession = await hydra.chat({ text: 'Keep working' })
    const workerTurn = othrys[harness].plan({
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
      turn.release()
      workerTurn.release()
    })
    await until({
      what: 'the worker to take its first held input',
      check: () => worker.received.some(input => input.includes('Keep working too')),
    })
    const page = await openTitan({
      port: othrys.port(),
      hydraId: hydra.id,
      reducedMotion: true,
    })
    await page.locator('[data-hydra-workspace][data-active=true] [data-task]').getByText(
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
          'Reply to Titan',
          'Titan conversation',
          hydraSession,
          'Answer this instead',
          'Stop Titan',
        ],
        [
          'Message worker',
          'Task interrupt conversation',
          worker,
          'Answer this too',
          'Stop worker',
        ],
      ] as const) {
      const nextTurn = othrys[harness].plan({
        hydra: hydra.id,
        match: ({ text: input }) => input.includes(text),
        partial: 'New reply',
        reply: 'Must not finish after Stop',
        hold: true,
      })
      onTestFinished(() => nextTurn.release())
      const conversation = page.locator('[data-hydra-workspace][data-active=true]').getByRole(
        'region',
        { name: chat },
      )
      await page.locator('[data-hydra-workspace][data-active=true]').getByRole(
        'textbox',
        {
          name: field,
          exact: true,
        },
      )
        .fill(text)
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
      const stopButton = page.locator('[data-hydra-workspace][data-active=true] .composer').getByRole(
        'button',
        {
          name: stop,
          exact: true,
        },
      )
      await stopButton.click()
      await until({
        what: 'the stopped turn to end',
        check: () => session.answered === session.received.length,
      })
      await stopButton.waitFor({ state: 'hidden' })
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
  { target: 'Titan' },
  { target: 'worker' },
])(
  'a refused $target send shows its error on the same bubble and Retry delivers the same id once',
  async ({ target }) => {
    const hydra = await othrys.hydra()
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

    if (target === 'Titan') {
      const turn = othrys.codex.plan({
        hydra: hydra.id,
        text: 'Keep working before refusal',
        hold: true,
      })
      onTestFinished(() => turn.release())
      await hydra.chat({ text: 'Keep working before refusal' })
      othrys.codex.refuseNextInterrupt()
    } else {
      othrys.codex.plan({
        hydra: hydra.id,
        match: ({ text: input }) => input.includes(text),
        refuse: true,
      })
    }

    const page = await openTitan({
      port: othrys.port(),
      hydraId: hydra.id,
      reducedMotion: true,
    })

    if (target === 'worker') {
      await page.locator('[data-hydra-workspace][data-active=true] [data-task]').getByText(
        'Task retry-input',
        { exact: true },
      )
        .click()
    }

    const label = target === 'Titan' ? 'Titan conversation' : 'Task retry-input conversation'
    const field = target === 'Titan' ? 'Reply to Titan' : 'Message worker'
    const conversation = page.locator('[data-hydra-workspace][data-active=true]').getByRole(
      'region',
      { name: label },
    )
    await page.locator('[data-hydra-workspace][data-active=true]').getByRole(
      'textbox',
      {
        name: field,
        exact: true,
      },
    )
      .fill(text)
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

    if (target === 'Titan') {
      await othrys.restart()
      await row.getByRole(
        'button',
        {
          name: 'Retry',
          exact: true,
        },
      ).waitFor()
      expect(await row.getByRole('alert').textContent()).toContain('refused')
    }

    const bubble = await row.locator('[data-entry-id]').elementHandle()

    if (!bubble) {
      throw new Error('No sent bubble before Retry')
    }

    othrys.codex.plan({
      hydra: hydra.id,
      match: ({ text: input }) => input.includes(text),
      refuse: true,
      refusalReason: 'the app-server refused the retry',
    })
    await row.getByRole(
      'button',
      {
        name: 'Retry',
        exact: true,
      },
    ).click()
    await until({
      what: 'the repeated refusal to reach the provider',
      check: () => othrys.codex.sessions.flatMap(session => session.received)
        .filter(input => input.includes(text)).length === (target === 'Titan' ? 1 : 2),
    })
    await row.getByRole('alert').filter({ hasText: 'refused the retry' })
      .waitFor()
    expect(await bubble.evaluate(node => node.isConnected)).toBe(true)
    await row.getByRole(
      'button',
      {
        name: 'Retry',
        exact: true,
      },
    ).click()
    const expectedAttempts = target === 'Titan' ? 2 : 3
    await until({
      what: 'the successful Retry turn to finish',
      check: () => {
        const sessions = othrys.codex.sessions.filter(session => session.received
          .some(input => input.includes(text)))
        const attempts = sessions.flatMap(session => session.received)
          .filter(input => input.includes(text))
        const latest = sessions.at(-1)

        return attempts.length === expectedAttempts && latest?.answered === latest?.received.length
      },
    })
    expect(await bubble.evaluate(node => node.isConnected)).toBe(true)
    expect(await row.count()).toBe(1)
    expect(await row.locator('[data-entry-id]').getAttribute('data-entry-id')).toBe(id)
    await row.getByRole('alert').waitFor({ state: 'hidden' })
    const attempts = othrys.codex.sessions.flatMap(session => session.received)
      .filter(input => input.includes(text))
    expect(attempts).toHaveLength(expectedAttempts)
    expect(await row.locator('time').count()).toBe(1)
  },
)

test.each([
  { harness: 'claude' },
  { harness: 'codex' },
] as const)(
  '$harness native replies keep the same mounted row when saved, repeated and reloaded in either chat',
  async ({ harness }) => {
    const hydra = await othrys.hydra()
    await hydra.startTask({
      key: 'native-replies',
      harness,
    })
    const socket = await hydra.page()
    await socket.send({
      name: 'hydra-agent',
      args: [JSON.stringify({ harness })],
    })
    const page = await openTitan({
      port: othrys.port(),
      hydraId: hydra.id,
      reducedMotion: true,
    })
    await page.locator('[data-hydra-workspace][data-active=true] [data-task]').getByText(
      'Task native-replies',
      { exact: true },
    )
      .click()
    const paragraph = `Native reply ${'all the recorded words survive. '.repeat(80)}`.trimEnd()
    const reply = `${paragraph}\n\n\`\`\`text\nEND_NATIVE_REPLY\n\`\`\``
    const identities: string[] = []

    for (const scope of [
      'Titan conversation',
      'Task native-replies conversation',
    ]) {
      const conversation = page.locator('[data-hydra-workspace][data-active=true]').getByRole(
        'region',
        {
          name: scope,
          exact: true,
        },
      )

      const send = async ({ text }: { text: string }) => {
        if (scope === 'Titan conversation') {
          await hydra.chat({ text })
        } else {
          await hydra.owner({
            args: [
              'task',
              'send',
              'native-replies',
              '--harness',
              harness,
              '--text',
              text,
            ],
          })
        }
      }

      for (const text of [
        'First native request',
        'Second native request',
      ]) {
        const turn = othrys[harness].plan({
          hydra: hydra.id,
          match: ({ text: input }) => input.endsWith(text),
          reply,
          splitReply: true,
          partial: 'Native reply',
          hold: true,
        })
        onTestFinished(() => turn.release())
        await send({ text })
        const partial = conversation.locator('[data-entry-id][data-streaming]').filter({ hasText: 'Native reply' })
        await partial.waitFor()
        const id = await partial.getAttribute('data-entry-id')
        expect(id).toBeTruthy()
        expect(identities).not.toContain(id)
        identities.push(id!)
        const mounted = await partial.elementHandle()
        turn.release()
        const saved = conversation.locator(`[data-entry-id="${id}"]`)
        await saved.getByText(
          paragraph,
          { exact: true },
        ).waitFor()
        expect((await saved.locator('pre code').textContent())?.trim()).toBe('END_NATIVE_REPLY')
        await until({
          what: 'the native reply to settle under its mounted key',
          check: async () => await saved.getAttribute('data-streaming') === null,
        })
        expect(await mounted.evaluate(({ isConnected }) => isConnected)).toBe(true)
        const copies = conversation.locator('[data-entry-id]').filter({ hasText: paragraph })
        const perTurn = harness === 'claude' ? 2 : 1
        expect(await copies.count()).toBe((text === 'First native request' ? 1 : 2) * perTurn)

        if (harness === 'claude') {
          const copiedIds: string[] = []

          for (const row of await copies.all()) {
            copiedIds.push((await row.getAttribute('data-entry-id'))!)
          }

          expect(new Set(copiedIds).size).toBe(copiedIds.length)
          identities.push(...copiedIds.filter(key => !identities.includes(key)))
        }

        expect(await conversation.getByText(
          text,
          { exact: true },
        ).count()).toBe(1)
      }
    }

    await page.reload()

    for (const id of identities) {
      await page.locator(`[data-hydra-workspace][data-active=true] [data-entry-id="${id}"]`)
        .getByText(
          paragraph,
          { exact: true },
        )
        .waitFor()
      expect((await page.locator(`[data-hydra-workspace][data-active=true] [data-entry-id="${id}"] pre code`)
        .textContent())?.trim()).toBe('END_NATIVE_REPLY')
    }

    socket.close()
  },
)

test(
  'a comment typed over a selected reply goes out with the next message, and Mod+L reaches the composer from anywhere',
  async () => {
    const hydra = await othrys.hydra()
    othrys.claude.plan({
      hydra: hydra.id,
      text: 'Say something',
      reply: 'Here is the reply to read.',
    })
    const session = await hydra.chat({ text: 'Say something' })
    const page = await openTitan({
      port: othrys.port(),
      hydraId: hydra.id,
    })
    const workspace = page.locator('[data-hydra-workspace][data-active=true]')
    const reply = workspace.getByText(
      'Here is the reply to read.',
      { exact: true },
    )
    await reply.waitFor()
    const composer = workspace.getByRole(
      'textbox',
      {
        name: 'Reply to Titan',
        exact: true,
      },
    )
    const composerFocus = () => composer.evaluate((field: HTMLTextAreaElement) => ({
      focused: field === document.activeElement,
      caret: field.selectionStart,
    }))
    await composer.fill('Draft')
    await composer.evaluate((field: HTMLTextAreaElement) => field.setSelectionRange(
      0,
      0,
    ))
    const line = await reply.boundingBox()

    if (!line) {
      throw new Error('The reply has no box on screen')
    }

    const middle = line.y + line.height / 2
    await page.mouse.move(
      line.x + 1,
      middle,
    )
    await page.mouse.down()
    await page.mouse.move(
      line.x + line.width - 1,
      middle,
      { steps: 4 },
    )
    await page.mouse.up()
    await workspace.getByRole(
      'button',
      { name: 'Comment on selection' },
    ).waitFor()
    await page.keyboard.type('looks right')
    expect(await workspace.getByRole(
      'textbox',
      {
        name: 'Comment on selected text',
        exact: true,
      },
    ).inputValue()).toBe('looks right')
    await page.keyboard.press('ControlOrMeta+l')
    expect(await composerFocus()).toEqual({
      focused: true,
      caret: 'Draft'.length,
    })
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.keyboard.press('ControlOrMeta+l')
    expect(await composerFocus()).toEqual({
      focused: true,
      caret: 'Draft'.length,
    })
    await page.keyboard.press('Enter')
    await until({
      what: 'the comment to go out with the message',
      check: () => session.received.some(text => text.includes('> Here is the reply to read.')
        && text.includes('looks right') && text.includes('Draft')),
    })
  },
)

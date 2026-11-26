import { beforeAll, expect, test } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadTitan } from '#app/store.ts'
import { TITAN_CARD } from '#titan/identity.ts'
import { createThreadReceiver } from '#titan/thread-receive.ts'
import { joinLatest, mergeThreadPages } from '#titan/thread-history.ts'
import { createTitanThreadView } from '#titan/thread-view.ts'
import { readThread, recordEntries, type ThreadPage } from '#titan/transcripts-read.ts'
import { liveReplies } from '#workers/streaming.ts'
import { compactionRuns, noticesInTimeline } from '../web/src/titan/chat.ts'
import { loadEarlierMessages } from '../web/src/titan/conversation-history.ts'
import { openPage, startOthrys, until, type Titan, type Othrys } from './setup/othrys.ts'
import { appendRecords, appendToolCalls } from './setup/transcripts.ts'

let othrys: Othrys

beforeAll(async () => {
  othrys = await startOthrys()
})

interface Entry {
  id: string
  at?: string
  role: string
  text: string
}

interface ThreadReceipt {
  thread: ThreadPage & {
    conversation: NonNullable<ThreadPage['conversation']>
  }
}

interface UpdatesReceipt {
  events: {
    seq: number
    type: string
    data: { after?: string }
  }[]
  older?: number
}

const EXCHANGES = 30
const BURST = 130
const NOTES_PAST_FIRST_PAGE = 70
// A reply larger than one transport part, which the page must still read whole.
const LONG_REPLY = `${'A long paragraph of the release notes. '.repeat(1500)}End of notes.`

test(
  'chat opens on its newest 20 entries, reading older pages reaches every message once, in order, with a long reply whole, and revealing an older message reads back only until it',
  async () => {
    const titan = await othrys.titan()
    let session

    for (let exchange = 1; exchange <= EXCHANGES; exchange++) {
      othrys.claude.plan({
        titan: titan.id,
        text: `question ${exchange}`,
        reply: exchange === 5 ? LONG_REPLY : `answer ${exchange}`,
      })
      session = await titan.chat({ text: `question ${exchange}` })
      const answered = session
      await until({
        what: `answer ${exchange}`,
        check: () => answered.answered === exchange,
      })
    }

    const page = await titan.page()
    const first = await page.send({
      name: 'thread',
      args: ['$titan'],
    }) as unknown as ThreadReceipt
    expect(first.thread.conversation.entries.map(entry => entry.text)).toEqual([
      'question 21',
      'answer 21',
      'question 22',
      'answer 22',
      'question 23',
      'answer 23',
      'question 24',
      'answer 24',
      'question 25',
      'answer 25',
      'question 26',
      'answer 26',
      'question 27',
      'answer 27',
      'question 28',
      'answer 28',
      'question 29',
      'answer 29',
      'question 30',
      'answer 30',
    ])
    expect(first.thread.older).toBeTruthy()

    const savedReply = first.thread.entries.find(entry => entry.text === 'answer 29')

    if (!savedReply) {
      throw new Error('The newest page has no saved reply')
    }

    const state = loadTitan({ titanId: titan.id }).state
    const detachedCard = {
      ...state.cards[TITAN_CARD],
      agent: undefined,
      sessionIds: [],
    }
    const detachedHistory = readThread({
      titanId: titan.id,
      card: detachedCard,
      state: {
        ...state,
        cards: {
          ...state.cards,
          [TITAN_CARD]: detachedCard,
        },
      },
    })
    expect(detachedHistory.entries.find(entry => entry.id === savedReply.id)?.text).toBe('answer 29')

    const project = createTitanThreadView({
      state,
      page: first.thread,
      tools: false,
      thinking: false,
    })

    for (const text of [
      'ans',
      'answer',
    ]) {
      const projected = project({
        page: {
          ...first.thread,
          entries: [
            {
              ...savedReply,
              text,
              streaming: true,
            },
          ],
        },
      })
      expect(projected.conversation.entries.find(entry => entry.id === savedReply.id)?.text).toBe('answer 29')
    }

    // A message that arrives while the owner reads back must neither be lost nor shift what was already read.
    othrys.claude.plan({
      titan: titan.id,
      text: 'question 31',
      reply: LONG_REPLY,
    })
    const latest = await titan.chat({ text: 'question 31' })
    await until({
      what: 'answer 31',
      check: () => latest.answered === EXCHANGES + 1,
    })

    const newestTab = await titan.page()
    const newest = await newestTab.send({
      name: 'thread',
      args: [TITAN_CARD],
    }) as unknown as ThreadReceipt
    newestTab.close()
    expect(newest.thread.conversation.entries.at(-1)?.text).toBe(LONG_REPLY)

    let loaded = first.thread
    const reads: number[] = []

    while (loaded.older) {
      const older = await page.send({
        name: 'thread',
        args: [
          '$titan',
          loaded.older,
        ],
      }) as unknown as ThreadReceipt
      reads.push(older.thread.conversation.entries.length)
      loaded = older.thread
    }

    page.close()
    expect(reads.length).toBeGreaterThan(0)
    const ids = loaded.conversation.entries.map(entry => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
    // Every message once and in order: each question, then its answer, from the first exchange to the last.
    expect(loaded.conversation.entries.map(entry => entry.text)).toEqual(Array.from(
      { length: EXCHANGES + 1 },
      (
        _,
        index,
      ) => [
        `question ${index + 1}`,
        index + 1 === 5 || index + 1 === EXCHANGES + 1 ? LONG_REPLY : `answer ${index + 1}`,
      ],
    ).flat())

    const commented = loaded.conversation.entries.find(entry => entry.text === 'question 15')
    const freshTab = await titan.page()

    const readPage = async ({ args }: { args: string[] }) => {
      const receipt = await freshTab.send({
        name: 'thread',
        args: [
          '$titan',
          ...args,
        ],
      }) as unknown as { thread: ThreadPage }

      return receipt.thread
    }

    let revealed = await readPage({ args: [] })
    await loadEarlierMessages({
      page: revealed,
      until: commented?.at,
      message: commented?.id,
      load: async ({ before }) => {
        revealed = await readPage({ args: [before] })

        return revealed
      },
    })
    freshTab.close()
    const revealedTexts = revealed.conversation?.entries.map(entry => entry.text)
    expect(revealedTexts).toContain('question 15')
    expect(revealedTexts).not.toContain('question 1')
  },
)

test(
  'a task\'s older chat stays ordered through new replies and session changes, and Focus mode controls tool calls',
  async () => {
    const titan = await othrys.titan()
    const { worker } = await titan.startTask({ key: 'notes' })
    const focusMode = ({ on }: { on: boolean }) => titan.owner({
      args: [
        'settings',
        'set',
        '--json',
        JSON.stringify({ focusMode: on }),
      ],
    })

    try {
      await appendToolCalls({
        session: worker,
        tools: 1,
      })
      await appendRecords({
        session: worker,
        records: Array.from(
          { length: NOTES_PAST_FIRST_PAGE },
          (
            _,
            index,
          ) => ({
            type: 'assistant' as const,
            content: `note ${index + 1}`,
          }),
        ),
      })
      const threads = createThreadReceiver()
      const page = await openPage({
        port: othrys.port(),
        titanId: titan.id,
        receive: ({ message }) => {
          threads.receive({ message })
        },
      })
      const first = await page.send({
        name: 'thread',
        args: ['notes'],
      }) as unknown as ThreadReceipt
      const olderCursor = first.thread.older

      if (!olderCursor) {
        throw new Error('The task\'s first page has no older page')
      }

      await page.send({
        name: 'thread',
        args: [
          'notes',
          olderCursor,
        ],
      })

      await appendRecords({
        session: worker,
        records: [
          {
            type: 'assistant',
            content: 'note after reading back',
          },
        ],
      })
      const loaded = () => threads.read({ card: first.thread.card })?.entries ?? []
      const notes = () => loaded().map(entry => entry.text)
        .filter(text => text.startsWith('note '))
      const toolRows = () => loaded().filter(entry => entry.kind === 'tool')
      await until({
        what: 'the note written after reading back',
        check: () => notes().includes('note after reading back'),
      })
      expect(toolRows()).toEqual([])

      await appendRecords({
        session: worker,
        records: Array.from(
          { length: BURST },
          (
            _,
            index,
          ) => ({
            type: 'assistant' as const,
            content: `burst ${index + 1}`,
          }),
        ),
      })
      const burst = () => loaded().map(entry => entry.text)
        .filter(text => text.startsWith('burst '))
      await until({
        what: 'the last line of the burst',
        check: () => burst().includes(`burst ${BURST}`),
      })
      expect(burst()).toHaveLength(BURST)
      expect(burst()[0]).toBe('burst 1')

      await focusMode({ on: false })
      await until({
        what: 'the tool call of the page read back to show once Focus mode is off',
        check: () => toolRows().length > 0,
      })
      await focusMode({ on: true })
      await until({
        what: 'Focus mode to hide it again',
        check: () => toolRows().length === 0,
      })
      page.close()
      const everyNote = [
        ...Array.from(
          { length: NOTES_PAST_FIRST_PAGE },
          (
            _,
            index,
          ) => `note ${index + 1}`,
        ),
        'note after reading back',
      ]
      expect(notes()).toEqual(everyNote)

      const reconnected = await titan.page()
      const restored = await reconnected.send({
        name: 'thread',
        args: [
          'notes',
          '--retain',
          JSON.stringify({
            session: first.thread.session,
            oldest: loaded()[0]?.id,
          }),
        ],
      }) as unknown as { thread: { entries: Entry[] } }
      const unknownOption = await reconnected.send({
        name: 'thread',
        args: [
          'notes',
          '--future-option',
        ],
      }) as unknown as { thread?: { entries: Entry[] } }
      reconnected.close()
      expect(
        restored.thread.entries.map(entry => entry.text).filter(text => text.startsWith('note ')),
        JSON.stringify(restored.thread),
      ).toEqual(everyNote)
      expect(unknownOption.thread?.entries.map(entry => entry.text)).toContain('note after reading back')

      const reference = loaded().find(entry => entry.text === 'note after reading back')?.reference
      expect(reference).toBeDefined()
      await titan.owner({
        args: [
          'task',
          'detach',
          'notes',
        ],
      })
      const lookedUp = await titan.owner({
        args: [
          'task',
          'messages',
          'notes',
          '--id',
          reference!,
        ],
      })
      expect(lookedUp.messages).toContainEqual(expect.objectContaining({
        id: reference,
        text: 'note after reading back',
      }))
    } finally {
      await focusMode({ on: true })
    }
  },
)

test(
  'Activity reads a card\'s updates newest first a page at a time, an update made while reading shifts nothing, and a bad page is refused',
  async () => {
    const titan = await othrys.titan()
    const { card } = await titan.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Long history',
        '--key',
        'long',
      ],
    })

    for (let edit = 1; edit <= 12; edit++) {
      await titan.owner({
        args: [
          'task',
          'brief',
          'long',
          '--brief',
          `brief ${edit}`,
        ],
      })
    }

    const page = await titan.page()

    const read = async ({ before }: { before?: number }) => {
      const args = [
        'updates',
        card.id,
        '--limit',
        '5',
      ]

      if (before !== undefined) {
        args.push(
          '--before',
          String(before),
        )
      }

      return await page.send({
        name: 'task',
        args,
      }) as unknown as UpdatesReceipt
    }

    const first = await read({})
    expect(first.events.map(event => event.data.after)).toEqual([
      'brief 12',
      'brief 11',
      'brief 10',
      'brief 9',
      'brief 8',
    ])

    await titan.owner({
      args: [
        'task',
        'brief',
        'long',
        '--brief',
        'brief 13',
      ],
    })

    const second = await read({ before: first.older })
    const third = await read({ before: second.older })
    expect(second.events.map(event => event.data.after)).toEqual([
      'brief 7',
      'brief 6',
      'brief 5',
      'brief 4',
      'brief 3',
    ])
    expect(third.events.map(event => event.data.after ?? event.type)).toEqual([
      'brief 2',
      'brief 1',
      'task.created',
    ])
    expect(third.older).toBeUndefined()

    const fresh = await read({})
    expect(fresh.events[0]?.data.after).toBe('brief 13')

    const cli = await titan.owner({
      args: [
        'task',
        'updates',
        'long',
        '--limit',
        '5',
      ],
    })
    const seqs = cli.events.map((event: { seq: number }) => event.seq)
    expect(seqs).toEqual(fresh.events.map(event => event.seq))

    for (const args of [
      [
        '--limit',
        '0',
      ],
      [
        '--limit',
        '100000',
      ],
      [
        '--before',
        'yesterday',
      ],
    ]) {
      const refused = await titan.ownerRefused({
        args: [
          'task',
          'updates',
          'long',
          ...args,
        ],
      })
      expect(refused.code).toBe('VALIDATION_ERROR')
    }

    const unknown = await page.send({
      name: 'task',
      args: [
        'updates',
        'task-missing',
      ],
    })
    expect(unknown.type).toBe('error')
    page.close()
  },
)

// What the chat holds for a Titan: its saved compactions, oldest first.
const compactions = ({ titan }: { titan: Titan }) => (loadTitan({
  titanId: titan.id,
}).state.cards[TITAN_CARD]).compaction?.operations ?? []

test(
  'a chat page shows only the compactions that happened within its messages, and compactions with no message between them fold into one run',
  async () => {
    const titan = await othrys.titan()
    let answered = 0
    let compacted = 0

    const exchange = async () => {
      answered += 1
      const number = answered
      othrys.claude.plan({
        titan: titan.id,
        text: `question ${number}`,
        reply: `answer ${number}`,
      })
      const session = await titan.chat({ text: `question ${number}` })
      await until({
        what: `answer ${number}`,
        check: () => session.answered >= number + compacted,
      })
    }

    const compact = async () => {
      const before = compactions({ titan }).length
      othrys.claude.plan({
        titan: titan.id,
        text: '/compact',
        compacting: true,
      })
      await titan.owner({
        args: [
          'titan',
          'send',
          '--text',
          '/compact',
        ],
      })
      await until({
        what: 'the compaction to finish and Titan to resume accepting messages',
        check: () => compactions({ titan }).filter(operation => operation.state === 'done').length > before
          && !loadTitan({ titanId: titan.id }).state.titanOperation,
      })
      compacted += 1
    }

    for (let count = 0; count < 4; count++) {
      await exchange()
    }

    // Two compactions early in the chat, then enough messages to push them onto an older page, then one in the newest.
    await compact()
    await compact()

    for (let count = 0; count < 12; count++) {
      await exchange()
    }

    await compact()
    await exchange()

    const page = await titan.page()
    const newest = (await page.send({
      name: 'thread',
      args: ['$titan'],
    }) as unknown as ThreadReceipt).thread
    expect(newest.older).toBeTruthy()
    const operations = compactions({ titan })
    expect(operations).toHaveLength(3)

    const shown = ({ thread }: { thread: ThreadReceipt['thread'] }) => noticesInTimeline({
      notices: operations,
      at: ({ notice }) => notice.startedAt,
      rows: thread.conversation.entries,
      older: thread.older !== undefined,
    })
    expect(shown({ thread: newest }).map(operation => operation.id)).toEqual([operations[2]!.id])

    let thread = newest

    while (thread.older) {
      thread = (await page.send({
        name: 'thread',
        args: [
          '$titan',
          thread.older,
        ],
      }) as unknown as ThreadReceipt).thread
    }

    page.close()
    const loaded = thread.conversation.entries
    // With the whole chat loaded, every compaction shows, each between its own messages.
    const everything = noticesInTimeline({
      notices: operations,
      at: ({ notice }) => notice.startedAt,
      rows: loaded,
      older: false,
    })
    expect(everything).toEqual(operations)
    expect(compactionRuns({
      operations: everything,
      rows: loaded,
    }).map(run => run.length)).toEqual([
      1,
      1,
      1,
    ])
    // A message at the same millisecond separates the preceding compaction from this one.
    expect(compactionRuns({
      operations: [
        {
          ...operations[0]!,
          startedAt: '2026-01-01T00:00:00.000Z',
        },
        {
          ...operations[1]!,
          startedAt: '2026-01-01T00:00:00.001Z',
        },
      ],
      rows: [{ at: '2026-01-01T00:00:00.001Z' }],
    }).map(run => run.length)).toEqual([
      1,
      1,
    ])
    // Compactions with no message between them, such as repeated automatic ones, fold into one run.
    expect(compactionRuns({
      operations: everything,
      rows: loaded.slice(-2),
    }).map(run => run.length)).toEqual([3])
  },
)

test.each([
  { provider: 'claude' },
  { provider: 'codex' },
] as const)(
  '$provider native text blocks keep their identity through filtering and streamed settlement',
  ({ provider }) => {
    const record = provider === 'claude' ? {
      type: 'assistant',
      uuid: 'record-uuid',
      message: {
        id: 'native-message',
        content: [
          {
            type: 'thinking',
            thinking: 'Consider the request',
          },
          {
            type: 'text',
            text: 'Same words',
          },
          {
            type: 'tool_use',
            id: 'native-call',
            name: 'Read',
            input: {},
          },
          {
            type: 'text',
            text: 'Same words',
          },
        ],
      },
    } : {
      type: 'response_item',
      payload: {
        type: 'message',
        id: 'native-message',
        role: 'assistant',
        content: [
          { type: 'input_image' },
          {
            type: 'output_text',
            text: 'Same words',
          },
          { type: 'input_image' },
          {
            type: 'output_text',
            text: 'Same words',
          },
        ],
      },
    }
    const entries = recordEntries({
      record,
      offset: 200,
      tools: false,
      thinking: false,
    })
    expect(entries.map(entry => entry.id)).toEqual([
      'native-message:1',
      'native-message:3',
    ])

    if (record.payload) {
      const splitSecret = recordEntries({
        record: {
          ...record,
          payload: {
            ...record.payload,
            content: [
              {
                type: 'output_text',
                text: 'Before sk-01234567',
              },
              {
                type: 'output_text',
                text: '89abcdef after',
              },
            ],
          },
        },
        offset: 200,
      })
      expect(splitSecret.map(entry => entry.text).join('')).toBe('Before [redacted] after')
    }

    expect(recordEntries({
      record,
      offset: 900,
      tools: false,
      thinking: false,
    }).map(entry => entry.id))
      .toEqual(entries.map(entry => entry.id))
    expect(recordEntries({
      record,
      offset: 200,
      session: 'session-one',
      tools: false,
      thinking: false,
    })
      .map(entry => entry.id)).toEqual([
      'session-one:native-message:1',
      'session-one:native-message:3',
    ])
    expect(recordEntries({
      record,
      offset: 900,
      session: 'session-two',
      tools: false,
      thinking: false,
    })
      .map(entry => entry.id)).toEqual([
      'session-two:native-message:1',
      'session-two:native-message:3',
    ])
    const replies = liveReplies()
    replies.start({})
    replies.update({
      id: provider === 'codex' ? 'native-message' : 'native-message:1',
      text: 'Same',
    })
    replies.update({
      id: 'other-message:0',
      text: 'Same words',
    })
    const page: ThreadPage = {
      card: 'task',
      entries,
      route: false,
      watching: 'unknown',
    }
    const combined = replies.page({ page })
    expect(combined.entries.map(entry => entry.text)).toEqual([
      'Same words',
      'Same words',
      'Same words',
    ])
    expect(combined.entries.map(entry => entry.id)).toEqual([
      'native-message:1',
      'native-message:3',
      'other-message:0',
    ])

    const live = liveReplies()
    live.start({})
    live.update({
      id: provider === 'codex' ? 'native-message' : 'native-message:1',
      text: LONG_REPLY,
    })
    const overlay = live.page({
      page: {
        ...page,
        entries: [],
      },
    })
    const restored = mergeThreadPages({
      before: overlay,
      latest: page,
      olderPage: true,
    })
    expect(restored.entries.map(entry => entry.text)).toEqual([
      'Same words',
      'Same words',
    ])
    const retained = mergeThreadPages({
      before: page,
      latest: overlay,
      olderPage: true,
    })
    expect(retained.entries).toEqual(restored.entries)
    const refreshed = mergeThreadPages({
      before: page,
      latest: {
        ...page,
        entries: page.entries.map(entry => ({
          ...entry,
          text: 'Fresh saved words',
        })),
      },
      olderPage: true,
    })
    expect(refreshed.entries.map(entry => entry.text)).toEqual([
      'Fresh saved words',
      'Fresh saved words',
    ])
  },
)

test.each([
  { retainedNative: true },
  { retainedNative: false },
])(
  'refresh fills a transcript gap despite an overlapping owner receipt with retained native rows: $retainedNative',
  ({ retainedNative }) => {
    const saved = ({
      id,
      offset,
    }: {
      id: string
      offset: number
    }) => ({
      id,
      offset,
      kind: 'message' as const,
      role: 'assistant',
      text: id,
      at: new Date(offset).toISOString(),
    })
    const first = saved({
      id: 'first',
      offset: 1,
    })
    const missed = saved({
      id: 'missed',
      offset: 2,
    })
    const newest = saved({
      id: 'newest',
      offset: 3,
    })
    const receipt = {
      id: 'reply:owner',
      kind: 'message' as const,
      role: 'You',
      text: 'Owner request',
      at: new Date(4).toISOString(),
    }
    const history: ThreadPage = {
      card: 'task',
      entries: retainedNative ? [
        first,
        receipt,
      ] : [receipt],
      route: false,
      watching: 'unknown',
    }
    const refreshed = joinLatest({
      history,
      latest: {
        ...history,
        entries: [
          newest,
          receipt,
        ],
        older: 'n3:0;r',
      },
      read: () => ({
        ...history,
        entries: [
          first,
          missed,
        ],
      }),
    })

    expect(refreshed.entries.map(entry => entry.id)).toEqual([
      first.id,
      missed.id,
      newest.id,
      receipt.id,
    ])
  },
)

test(
  'split Claude records preserve global native block positions when read from an older-page boundary',
  () => {
    const path = join(
      process.env.TMPDIR!,
      'split-native-blocks.jsonl',
    )
    const content = [
      {
        type: 'text',
        text: 'Same words',
      },
      {
        type: 'thinking',
        thinking: 'Hidden thought',
      },
      {
        type: 'tool_use',
        id: 'split-call',
        name: 'Read',
        input: {},
      },
      {
        type: 'text',
        text: 'Same words',
      },
    ]
    const records = content.map((
      block,
      index,
    ) => ({
      type: 'assistant',
      uuid: `split-record-${index}`,
      message: {
        id: 'split-message',
        content: [block],
      },
    }))
    const lines = records.map(record => JSON.stringify(record) + '\n')
    writeFileSync(
      path,
      lines.join(''),
    )
    const entries = records.flatMap((
      record,
      index,
    ) => recordEntries({
      path,
      record,
      offset: Buffer.byteLength(lines.slice(
        0,
        index,
      ).join('')),
      tools: false,
      thinking: false,
      session: 'split-session',
    }))
    expect(entries.map(entry => entry.id)).toEqual([
      'split-session:split-message:0',
      'split-session:split-message:3',
    ])
    expect(entries.map(entry => entry.text)).toEqual([
      'Same words',
      'Same words',
    ])
  },
)

import { beforeAll, expect, test } from 'vitest'
import { HYDRA_CARD } from '#hydra/identity.ts'
import type { Compaction } from '#workers/compaction/model.ts'
import { compactionRuns, noticesInTimeline } from '../web/src/hydra/chat.ts'
import { rows, startPnyx, until, type Hydra, type Pnyx } from './setup/pnyx.ts'

let pnyx: Pnyx

beforeAll(async () => {
  pnyx = await startPnyx()
})

interface Entry {
  id: string
  at?: string
  role: string
  text: string
}

interface ThreadReceipt {
  thread: {
    older?: string
    conversation: { entries: Entry[] }
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
// A reply larger than one transport part, which the page must still read whole.
const LONG_REPLY = `${'A long paragraph of the release notes. '.repeat(1500)}End of notes.`

test(
  'chat opens on its newest 20 entries, and reading older pages reaches every message once, in order, with a long reply whole',
  async () => {
    const hydra = await pnyx.hydra()
    let session

    for (let exchange = 1; exchange <= EXCHANGES; exchange++) {
      pnyx.claude.plan({
        hydra: hydra.id,
        text: `question ${exchange}`,
        reply: exchange === 5 ? LONG_REPLY : `answer ${exchange}`,
      })
      session = await hydra.chat({ text: `question ${exchange}` })
      const answered = session
      await until({
        what: `answer ${exchange}`,
        check: () => answered.answered === exchange,
      })
    }

    const page = await hydra.page()
    const first = await page.send({
      name: 'thread',
      args: ['$hydra'],
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

    // A message that arrives while the owner reads back must neither be lost nor shift what was already read.
    pnyx.claude.plan({
      hydra: hydra.id,
      text: 'question 31',
      reply: 'answer 31',
    })
    const latest = await hydra.chat({ text: 'question 31' })
    await until({
      what: 'answer 31',
      check: () => latest.answered === EXCHANGES + 1,
    })

    let loaded = first.thread
    const reads: number[] = []

    while (loaded.older) {
      const older = await page.send({
        name: 'thread',
        args: [
          '$hydra',
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
        index + 1 === 5 ? LONG_REPLY : `answer ${index + 1}`,
      ],
    ).flat())
  },
)

test(
  'Activity reads a card\'s updates newest first a page at a time, an update made while reading shifts nothing, and a bad page is refused',
  async () => {
    const hydra = await pnyx.hydra()
    const { card } = await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'Long history',
        '--key',
        'long',
      ],
    })

    for (let edit = 1; edit <= 12; edit++) {
      await hydra.owner({
        args: [
          'task',
          'brief',
          'long',
          '--brief',
          `brief ${edit}`,
        ],
      })
    }

    const page = await hydra.page()

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

    await hydra.owner({
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

    const cli = await hydra.owner({
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
      const refused = await hydra.ownerRefused({
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

// What the chat holds for a Hydra: its saved compactions, oldest first.
const compactions = ({ hydra }: { hydra: Hydra }) => rows<{
  data: { compaction?: { operations: Compaction[] } }
}>({
  text: 'select data from card_bodies where hydra_id = $1 and card_id = $2',
  values: [
    hydra.id,
    HYDRA_CARD,
  ],
})[0]?.data.compaction?.operations ?? []

test(
  'a chat page shows only the compactions that happened within its messages, and compactions with no message between them fold into one run',
  async () => {
    const hydra = await pnyx.hydra()
    let answered = 0
    let compacted = 0

    const exchange = async () => {
      answered += 1
      const number = answered
      pnyx.claude.plan({
        hydra: hydra.id,
        text: `question ${number}`,
        reply: `answer ${number}`,
      })
      const session = await hydra.chat({ text: `question ${number}` })
      await until({
        what: `answer ${number}`,
        check: () => session.answered >= number + compacted,
      })
    }

    const compact = async () => {
      const before = compactions({ hydra }).length
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
      await until({
        what: 'the compaction to finish',
        check: () => compactions({ hydra }).filter(operation => operation.state !== 'running')
          .length > before,
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

    const page = await hydra.page()
    const newest = (await page.send({
      name: 'thread',
      args: ['$hydra'],
    }) as unknown as ThreadReceipt).thread
    expect(newest.older).toBeTruthy()
    const operations = compactions({ hydra })
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
          '$hydra',
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

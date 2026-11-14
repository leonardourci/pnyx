import { appendFileSync } from 'node:fs'
import { beforeAll, expect, test } from 'vitest'
import { transcriptPath } from '#workers/claude.ts'
import { rows, startPnyx, until, type Hydra, type Output, type Pnyx } from './setup/pnyx.ts'

let pnyx: Pnyx

beforeAll(async () => {
  pnyx = await startPnyx()
})

// A live-size Hydra: its log holds tens of thousands of events, a few of them words that history shows, and its native
// transcript holds thousands of replies spread between them. Reading the range once used to run one statement per reply
// over the whole log, which Postgres cancelled after ten seconds.
const EVENTS = 60_000
const BRIEF_EVERY = 25
const INSERT_BATCH = 5_000
const REPLIES = 7_000
// No replies between these, a stretch of the log longer than one window of a lookup.
const GAP = {
  from: 4_000,
  to: 4_500,
}
const BASE = Date.parse('2099-01-01T00:00:00.000Z')

interface Fixture {
  hydra: Hydra
  // The log position before the first bulk event.
  last: number
  // The words in log order: a brief is placed at its event, a reply between two events.
  order: string[]
  replySeq: ({ k }: { k: number }) => number
}

let fixture: Fixture | undefined

// The reply k sits half a second after this event of the bulk, so it takes the position of the event after it.
const replyAfter = ({ k }: { k: number }) => 1 + Math.floor(k * (EVENTS - 1) / REPLIES)

const inGap = ({ k }: { k: number }) => k >= GAP.from && k < GAP.to

async function longHydra(): Promise<Fixture> {
  if (fixture) {
    return fixture
  }

  const hydra = await pnyx.hydra({ id: 'long' })
  pnyx.claude.plan({
    hydra: hydra.id,
    text: 'hello',
    reply: 'Hi.',
  })
  const session = await hydra.chat({ text: 'hello' })
  await until({
    what: 'the first answer',
    check: () => session.answered === 1,
  })
  const busy = (await hydra.owner({
    args: [
      'task',
      'create',
      '--title',
      'Busy task',
      '--key',
      'busy',
    ],
  })).card.id as string
  const transcript = transcriptPath({
    cwd: session.cwd,
    session: session.id,
    folder: session.env.CLAUDE_CONFIG_DIR,
  })

  const [{ last }] = rows<{ last: string }>({
    text: 'select max(seq) as last from events where hydra_id = $1',
    values: [hydra.id],
  })
  const first = Number(last)

  await pnyx.restart({
    whileStopped: () => {
      // Several statements, so a loaded machine never pushes one past the statement limit.
      for (let start = 1; start <= EVENTS; start += INSERT_BATCH) {
        rows({
          text: `insert into events (hydra_id, seq, id, type, at, actor, card_id, data)
          select $1::text, $2::bigint + n, 'bulk' || n, kind, at, 'hook:claude', $3::text, json_build_object('v', 1,
            'id', 'bulk' || n, 'seq', $2::bigint + n, 'type', kind, 'cardId', $3::text, 'actor', 'hook:claude', 'at', at,
            'data', case kind when 'task.brief' then json_build_object('before', 'bulk ' || (n - 1), 'after', 'bulk ' || n)
              else json_build_object('before', false, 'after', false) end)
          from generate_series($4::integer, $6::integer) as n,
            lateral (select to_char(timestamp '2099-01-01' + n * interval '1 second', 'YYYY-MM-DD"T"HH24:MI:SS.000"Z"') as at,
              case when n % $5::integer = 0 then 'task.brief' else 'task.visibility' end as kind) as time`,
          values: [
            hydra.id,
            first,
            busy,
            start,
            BRIEF_EVERY,
            Math.min(
              start + INSERT_BATCH - 1,
              EVENTS,
            ),
          ],
        })
      }

      rows({
        text: 'update hydras set seq = (select max(seq) from events where hydra_id = $1) where id = $1',
        values: [hydra.id],
      })

      let lines = ''

      for (let k = 0; k < REPLIES; k++) {
        if (inGap({ k })) {
          continue
        }

        const long = k % 100 === 0 ? 'x'.repeat(2500) : ''
        lines += `${JSON.stringify({
          type: 'assistant',
          timestamp: new Date(BASE + replyAfter({ k }) * 1000 + 500).toISOString(),
          message: {
            role: 'assistant',
            content: `reply-${k} ${long} end-${k}`,
          },
        })}\n`
      }

      appendFileSync(
        transcript,
        lines,
      )
    },
  })

  const briefs = Array.from(
    { length: EVENTS / BRIEF_EVERY },
    (
      _,
      index,
    ) => ({
      position: (index + 1) * BRIEF_EVERY,
      word: `bulk ${(index + 1) * BRIEF_EVERY}`,
    }),
  )
  const replies = Array.from(
    { length: REPLIES },
    (
      _,
      k,
    ) => ({
      position: replyAfter({ k }) + 0.5,
      word: `reply-${k} `,
      k,
    }),
  ).filter(({ k }) => !inGap({ k }))
  const order = [
    ...briefs,
    ...replies,
  ].sort((
    a,
    b,
  ) => a.position - b.position).map(item => item.word)

  fixture = {
    hydra,
    last: first,
    order,
    replySeq: ({ k }) => first + replyAfter({ k }) + 1,
  }

  return fixture
}

interface Page {
  text: string
  more: boolean
  after: string
  through: number
  snapshot: number
}

async function readAll({
  hydra,
  args,
}: {
  hydra: Hydra
  args: string[]
}) {
  const pages: Page[] = []
  let after: string | undefined

  do {
    const page = await hydra.owner({
      args: [
        'hydra',
        'history',
        ...args,
        ...after ? [
          '--after',
          after,
        ] : [],
      ],
    }) as Page

    pages.push(page)
    after = page.more ? page.after : undefined
  } while (after)

  return pages
}

const wordsOf = ({ pages }: { pages: Page[] }) => pages.flatMap(page => [...page.text.matchAll(/bulk \d+|reply-\d+ /g)]
  .map(match => match[0]))

test(
  'a long range of Hydra history reads page by page in log order, each reply once, where it used to time out',
  async () => {
    const {
      hydra,
      order,
      last,
    } = await longHydra()

    const pages = await readAll({
      hydra,
      args: [
        '--since',
        'origin',
      ],
    })

    expect(pages.length).toBeGreaterThan(20)
    expect(wordsOf({ pages })).toEqual(order)
    expect(pages.every(page => page.snapshot === last + EVENTS)).toBe(true)
    expect(pages.at(-1)!.more).toBe(false)

    const count = await hydra.owner({
      args: [
        'hydra',
        'history',
        '--since',
        'origin',
        '--count',
      ],
    })
    const joined = pages.map(page => page.text).join('\n\n')
    expect(count.totalTokens).toBe(Math.ceil(Buffer.byteLength(joined) / 4))
  },
  120_000,
)

test(
  'a history cursor resumes at its own position, and a snapshot taken partway ends where it was taken',
  async () => {
    const {
      hydra,
      last,
      order,
    } = await longHydra()
    const middle = last + EVENTS / 2
    const pages = await readAll({
      hydra,
      args: [
        '--since',
        'origin',
        '--through',
        String(middle),
      ],
    })
    const expected = order.filter(word => {
      const [
        , kind,
        number,
      ] = /^(bulk |reply-)(\d+)/.exec(word)!

      return kind === 'bulk ' ? Number(number) <= EVENTS / 2 : replyAfter({ k: Number(number) }) + 1 <= EVENTS / 2
    })
    expect(wordsOf({ pages })).toEqual(expected)

    const refused = await hydra.ownerRefused({
      args: [
        'hydra',
        'history',
        '--since',
        'origin',
        '--after',
        'h1:0:10:0',
      ],
    })
    expect(refused.code).toBe('VALIDATION_ERROR')
  },
  120_000,
)

test(
  'a message lookup reads the replies around a reference and a range of the long thread in both directions',
  async () => {
    const {
      hydra,
      replySeq,
    } = await longHydra()
    const one = await hydra.owner({
      args: [
        'hydra',
        'message',
        '--seq',
        String(replySeq({ k: 3500 })),
      ],
    })
    expect(one.messages).toHaveLength(1)
    expect(one.messages[0].text).toContain('reply-3500 ')
    const reference = one.messages[0].id as string

    const around = await hydra.owner({
      args: [
        'hydra',
        'message',
        '--id',
        reference,
        '--before',
        '2',
        '--after',
        '2',
      ],
    })
    expect(around.anchor).toBe(reference)
    expect(around.messages.map((message: { text: string }) => /reply-(\d+)/.exec(message.text)![1])).toEqual([
      '3498',
      '3499',
      '3500',
      '3501',
      '3502',
    ])

    // Six hundred replies span more than one window of the log.
    const range = [
      '--from',
      String(replySeq({ k: 1000 })),
      '--to',
      String(replySeq({ k: 1599 })),
      '--limit',
      '60',
    ]
    const expected = Array.from(
      { length: 600 },
      (
        _,
        index,
      ) => String(1000 + index),
    )
    const numbers = ({ page }: { page: Output }) => page.messages
      .map((message: { text: string }) => /reply-(\d+)/.exec(message.text)![1])

    let older = await hydra.owner({
      args: [
        'hydra',
        'message',
        ...range,
        '--direction',
        'older',
      ],
    })
    const fromNewest = numbers({ page: older })

    while (older.older) {
      older = await hydra.owner({
        args: [
          'hydra',
          'message',
          '--cursor',
          older.older,
          '--limit',
          '60',
        ],
      })
      fromNewest.unshift(...numbers({ page: older }))
    }

    expect(fromNewest).toEqual(expected)

    let newer = await hydra.owner({
      args: [
        'hydra',
        'message',
        ...range,
      ],
    })
    const fromOldest = numbers({ page: newer })

    while (newer.newer) {
      newer = await hydra.owner({
        args: [
          'hydra',
          'message',
          '--cursor',
          newer.newer,
          '--limit',
          '60',
        ],
      })
      fromOldest.push(...numbers({ page: newer }))
    }

    expect(fromOldest).toEqual(expected)

    const acrossBack = await hydra.owner({
      args: [
        'hydra',
        'message',
        '--seq',
        String(replySeq({ k: GAP.to })),
        '--direction',
        'older',
        '--limit',
        '2',
      ],
    })
    expect(numbers({ page: acrossBack })).toEqual([
      '3998',
      '3999',
    ])
    const acrossForward = await hydra.owner({
      args: [
        'hydra',
        'message',
        '--seq',
        String(replySeq({ k: GAP.from - 1 })),
        '--direction',
        'newer',
        '--limit',
        '2',
      ],
    })
    expect(numbers({ page: acrossForward })).toEqual([
      '4500',
      '4501',
    ])

    const missing = await hydra.ownerRefused({
      args: [
        'hydra',
        'message',
        '--id',
        'no-such-session:12:m0',
      ],
    })
    expect(missing.code).toBe('NOT_FOUND')

    const timed = await hydra.owner({
      args: [
        'hydra',
        'message',
        '--from',
        new Date(BASE + replyAfter({ k: 2000 }) * 1000).toISOString(),
        '--to',
        new Date(BASE + replyAfter({ k: 2001 }) * 1000 + 600).toISOString(),
      ],
    })
    expect(numbers({ page: timed })).toEqual([
      '2000',
      '2001',
    ])
  },
  120_000,
)

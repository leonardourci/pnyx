import { appendFileSync } from 'node:fs'
import { beforeAll, expect, test } from 'vitest'
import { applyDecision } from '#app/decision.ts'
import { withWriter } from '#app/writer.ts'
import { decideSessionFacts } from '#workers/session-facts.ts'
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

// Events a second apart from 2099-01-01, a task brief every BRIEF_EVERY of them.
function insertEvents({
  hydraId,
  first,
  card,
  count,
}: {
  hydraId: string
  first: number
  card: string
  count: number
}) {
  // Several statements, so a loaded machine never pushes one past the statement limit.
  for (let start = 1; start <= count; start += INSERT_BATCH) {
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
        hydraId,
        first,
        card,
        start,
        BRIEF_EVERY,
        Math.min(
          start + INSERT_BATCH - 1,
          count,
        ),
      ],
    })
  }
}

// A Hydra that has answered once, with a task to hang bulk events on and the path of its transcript.
async function seededHydra({ id }: { id: string }) {
  const hydra = await pnyx.hydra({ id })
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
      '--no-start',
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

  return {
    hydra,
    busy,
    transcript,
    first,
  }
}

async function longHydra(): Promise<Fixture> {
  if (fixture) {
    return fixture
  }

  const {
    hydra,
    busy,
    transcript,
    first,
  } = await seededHydra({ id: 'long' })

  await pnyx.restart({
    whileStopped: () => {
      insertEvents({
        hydraId: hydra.id,
        first,
        card: busy,
        count: EVENTS,
      })

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
  'an explicit push retry returns the original receipt for a live observation',
  async () => {
    const hydra = await pnyx.hydra()
    await hydra.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--key',
        'push-receipt',
        '--title',
        'Push receipt',
      ],
    })
    const args = [
      'push',
      '--key',
      'push-receipt',
      '--file',
      '-',
      '--event-id',
      'activity-receipt',
    ]
    const input = JSON.stringify({ activity: 'working' })
    const first = await hydra.owner({
      args,
      input,
    })
    const retry = await hydra.owner({
      args,
      input,
    })
    expect(retry.duplicate).toBe('event id already applied; nothing appended')
    expect(retry.event).toEqual(first.event)
  },
)

test(
  'an undo receipt belongs to the edit it reversed',
  async () => {
    const hydra = await pnyx.hydra()
    await hydra.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--key',
        'undo-receipt',
        '--title',
        'Original',
      ],
    })

    for (const edit of [
      'first-edit',
      'second-edit',
    ]) {
      await hydra.owner({
        args: [
          'task',
          'rename',
          'undo-receipt',
          '--title',
          edit,
          '--event-id',
          edit,
        ],
      })
    }

    const args = [
      'undo',
      'second-edit',
      '--event-id',
      'undo-edit',
    ]
    const first = await hydra.owner({ args })
    const retry = await hydra.owner({ args })
    expect(retry.event).toEqual(first.event)
    expect(retry.duplicate).toBe('event id already applied; nothing appended')
    expect((await hydra.ownerRefused({
      args: [
        'undo',
        'first-edit',
        '--event-id',
        'undo-edit',
      ],
    })).code).toBe('IDEMPOTENCY_CONFLICT')
  },
)

test(
  'expired observation ids cannot replay stale activity after restart',
  async () => {
    const hydra = await pnyx.hydra()
    const receipts: {
      key: string
      id: string
    }[] = []

    for (const key of [
      'explicit',
      'generated',
    ]) {
      await hydra.owner({
        args: [
          'task',
          'create',
          '--no-start',
          '--key',
          key,
          '--title',
          key,
        ],
      })
      const first = await hydra.owner({
        args: [
          'push',
          '--key',
          key,
          '--file',
          '-',
          ...(key === 'explicit' ? [
            '--event-id',
            'start-1',
          ] : []),
        ],
        input: JSON.stringify({ activity: 'working' }),
      })
      receipts.push({
        key,
        id: first.event.id,
      })
      await hydra.owner({
        args: [
          'push',
          '--key',
          key,
          '--file',
          '-',
        ],
        input: JSON.stringify({ activity: 'finished' }),
      })
    }

    await pnyx.restart()

    for (const {
      key,
      id,
    } of receipts) {
      const refused = await hydra.ownerRefused({
        args: [
          'push',
          '--key',
          key,
          '--file',
          '-',
          '--event-id',
          id,
        ],
        input: JSON.stringify({ activity: 'working' }),
      })
      expect(refused.code).toBe('RECEIPT_EXPIRED')
      const { task } = await hydra.owner({
        args: [
          'task',
          'show',
          key,
          '--full',
        ],
      })
      expect(task.activity).toBe('finished')
      expect(rows({
        text: 'select id from events where hydra_id = $1 and id = $2',
        values: [
          hydra.id,
          id,
        ],
      })).toEqual([])
    }
  },
)

test(
  'undoing a title edit observed by another task’s session preserves both assignments',
  async () => {
    const hydra = await pnyx.hydra()

    for (const key of [
      'first',
      'second',
    ]) {
      await hydra.owner({
        args: [
          'task',
          'create',
          '--no-start',
          '--key',
          key,
          '--title',
          key,
        ],
      })
      await hydra.owner({
        args: [
          'push',
          '--key',
          key,
          '--file',
          '-',
        ],
        input: JSON.stringify({
          agent: {
            provider: 'claude',
            sessionId: key,
          },
          activity: 'working',
        }),
      })
    }

    await hydra.owner({
      args: [
        'push',
        '--key',
        'first',
        '--event-id',
        'mixed-edit',
        '--file',
        '-',
      ],
      input: JSON.stringify({
        title: 'Renamed',
        agent: {
          provider: 'claude',
          sessionId: 'second',
        },
        activity: 'finished',
      }),
    })
    await hydra.owner({
      args: [
        'undo',
        'mixed-edit',
        '--event-id',
        'reverse-mixed-edit',
      ],
    })
    expect((await hydra.task({ key: 'first' })).title).toBe('first')
    await hydra.owner({
      args: [
        'undo',
        'reverse-mixed-edit',
      ],
    })
    expect((await hydra.task({ key: 'first' })).title).toBe('Renamed')

    for (const key of [
      'first',
      'second',
    ]) {
      const { task } = await hydra.owner({
        args: [
          'task',
          'show',
          key,
          '--full',
        ],
      })
      expect(task.agent.sessionId).toBe(key)
      expect(task.sessionIds).toEqual([`claude:${key}`])
      expect(task.activity).toBe(key === 'first' ? 'working' : 'finished')
    }
  },
)

test(
  'completed native replies remain in history after observations leave the log and after restart',
  async () => {
    const hydra = await pnyx.hydra()
    pnyx.claude.plan({
      hydra: hydra.id,
      text: 'Read native history',
      reply: 'NATIVE-HISTORY-END',
    })
    const session = await hydra.chat({ text: 'Read native history' })
    await until({
      what: 'the native reply',
      check: () => session.answered === 1,
    })
    const delayedAt = '2099-01-01T00:00:05.000Z'
    appendFileSync(
      transcriptPath({
        cwd: session.cwd,
        session: session.id,
        folder: session.env.CLAUDE_CONFIG_DIR,
      }),
      `${JSON.stringify({
        type: 'assistant',
        timestamp: delayedAt,
        message: {
          role: 'assistant',
          content: 'NATIVE-TIME-LOOKUP',
        },
      })}\n`,
    )
    await withWriter({
      hydraId: hydra.id,
      fn: ({ writer }) => {
        const native = Object.values(writer.state.sessions ?? {}).find(candidate =>
          candidate.agent.sessionId === session.id)

        if (!native) {
          throw new Error('The native Hydra session is missing')
        }

        applyDecision({
          writer,
          decision: decideSessionFacts({
            state: writer.state,
            fields: {
              agent: native.agent,
              activity: 'working',
            },
            meta: {
              actor: 'pnyx',
              at: '2099-01-01T00:00:04.999Z',
            },
          }),
        })
        applyDecision({
          writer,
          decision: decideSessionFacts({
            state: writer.state,
            fields: {
              agent: native.agent,
              activity: 'finished',
            },
            meta: {
              actor: 'pnyx',
              at: '2099-01-01T00:00:05.001Z',
            },
          }),
        })
      },
    })
    const live = await hydra.owner({
      args: [
        'hydra',
        'history',
        '--since',
        'origin',
      ],
    })
    expect(live.text).toContain('NATIVE-HISTORY-END')
    const at = await hydra.owner({
      args: [
        'hydra',
        'message',
        '--at',
        delayedAt,
      ],
    })
    expect(at.messages).toContainEqual(expect.objectContaining({ text: 'NATIVE-TIME-LOOKUP' }))
    await pnyx.restart()
    const restored = await hydra.owner({
      args: [
        'hydra',
        'history',
        '--since',
        'origin',
      ],
    })
    expect(restored.text).toContain('NATIVE-HISTORY-END')
    const restoredAt = await hydra.owner({
      args: [
        'hydra',
        'message',
        '--at',
        delayedAt,
      ],
    })
    expect(restoredAt.messages).toContainEqual(expect.objectContaining({ text: 'NATIVE-TIME-LOOKUP' }))
    const range = await hydra.owner({
      args: [
        'hydra',
        'message',
        '--from',
        delayedAt,
        '--to',
        delayedAt,
      ],
    })
    expect(range.messages).toContainEqual(expect.objectContaining({ text: 'NATIVE-TIME-LOOKUP' }))
  },
)

test(
  'an inscribe retry survives a restart without another history event',
  async () => {
    const hydra = await pnyx.hydra()
    const args = [
      'hydra',
      'inscribe',
      'start',
      '--key',
      'stored-pass',
      '--event-id',
      'stored-pass-start',
    ]
    const first = await hydra.owner({ args })
    await hydra.owner({
      args: [
        'hydra',
        'inscribe',
        'finish',
        '--key',
        'stored-pass',
      ],
    })
    const saved = rows<{
      id: string
      type: string
    }>({
      text: 'select id, type from events where hydra_id = $1 order by seq',
      values: [hydra.id],
    })
    expect(saved.map(event => event.type)).not.toContain('hydra.operation')
    await pnyx.restart()
    const retried = await hydra.owner({ args })
    expect(retried.duplicate).toBe('event id already applied; nothing appended')
    expect(retried.event).toEqual(first.event)
    expect(retried.milestone).toBe('stored-pass')
    expect(rows({
      text: 'select id, type from events where hydra_id = $1 order by seq',
      values: [hydra.id],
    })).toEqual(saved)
  },
)

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
    await hydra.owner({
      args: [
        'hydra',
        'inscribe',
        'start',
        '--key',
        'first-pass',
        '--event-id',
        'first-pass-start',
      ],
    })
    const overlapping = await hydra.owner({
      args: [
        'hydra',
        'inscribe',
        'start',
        '--key',
        'second-pass',
      ],
    })
    expect(overlapping.notices).toContainEqual(expect.objectContaining({ reason: expect.stringContaining('still open') }))
    const retried = await hydra.owner({
      args: [
        'hydra',
        'inscribe',
        'start',
        '--key',
        'first-pass',
        '--event-id',
        'first-pass-start',
      ],
    })
    expect(retried.notices ?? []).not.toContainEqual(expect.objectContaining({ reason: expect.stringContaining('still open') }))
    expect((await hydra.ownerRefused({
      args: [
        'hydra',
        'inscribe',
        'finish',
        '--key',
        'second-pass',
        '--through',
        String(Number.MAX_SAFE_INTEGER),
      ],
    })).code).toBe('VALIDATION_ERROR')

    const incomplete = await hydra.owner({
      args: [
        'hydra',
        'inscribe',
        'finish',
        '--key',
        'second-pass',
      ],
    })
    expect(incomplete.notices).toContainEqual(expect.objectContaining({ reason: expect.stringContaining('history snapshot') }))
    expect((await hydra.owner({
      args: [
        'hydra',
        'history',
        '--since',
        'last-inscribe',
        '--count',
      ],
    })).totalTokens).toBe(0)
    const completed = await hydra.owner({
      args: [
        'hydra',
        'history',
        '--since',
        incomplete.milestone,
        '--count',
      ],
    })
    expect(completed.boundary).toBe(incomplete.through)
    expect(completed.totalTokens).toBe(0)
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

// Six hundred replies numbered 1000 to 1599, each once and in order.
function expectRun({ numbers }: { numbers: string[] }) {
  expect(numbers).toHaveLength(600)
  expect(numbers[0]).toBe('1000')
  expect(numbers.at(-1)).toBe('1599')
  expect(numbers.every((
    value,
    index,
  ) => index === 0 || Number(value) - Number(numbers[index - 1]) === 1)).toBe(true)
}

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
    expect(Boolean(around.older)).toBe(true)
    expect(Boolean(around.newer)).toBe(true)

    const last = await hydra.owner({
      args: [
        'hydra',
        'message',
        '--seq',
        String(replySeq({ k: REPLIES - 1 })),
        '--before',
        '1',
      ],
    })
    expect(last.messages.map((message: { text: string }) => /reply-(\d+)/.exec(message.text)![1])).toEqual([
      '6998',
      '6999',
    ])
    expect(Boolean(last.older)).toBe(true)
    expect(Boolean(last.newer)).toBe(false)

    // Six hundred replies span more than one window of the log.
    const range = [
      '--from',
      String(replySeq({ k: 1000 })),
      '--to',
      String(replySeq({ k: 1599 })),
      '--limit',
      '60',
    ]
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

    expectRun({ numbers: fromNewest })

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

    expectRun({ numbers: fromOldest })

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

// Replies far denser than the log, each a few milliseconds after the one before it: more in one window of positions than a read keeps, so it halves the range.
const DENSE_EVENTS = 600
const DENSE_REPLIES = 2_500

test(
  'a message lookup reads a transcript denser than one read keeps in both directions, each reply once and in order',
  async () => {
    const {
      hydra,
      busy,
      transcript,
      first,
    } = await seededHydra({ id: 'dense' })

    await pnyx.restart({
      whileStopped: () => {
        insertEvents({
          hydraId: hydra.id,
          first,
          card: busy,
          count: DENSE_EVENTS,
        })
        rows({
          text: 'update hydras set seq = (select max(seq) from events where hydra_id = $1) where id = $1',
          values: [hydra.id],
        })

        let lines = ''
        let previous = 0
        let inside = 0

        for (let k = 0; k < DENSE_REPLIES; k++) {
          const after = 1 + Math.floor(k * (DENSE_EVENTS - 1) / DENSE_REPLIES)
          inside = after === previous ? inside + 1 : 0
          previous = after
          lines += `${JSON.stringify({
            type: 'assistant',
            timestamp: new Date(BASE + after * 1000 + 10 * (1 + inside)).toISOString(),
            message: {
              role: 'assistant',
              content: `reply-${k} end`,
            },
          })}\n`
        }

        appendFileSync(
          transcript,
          lines,
        )
      },
    })

    const numbers = ({ page }: { page: Output }) => page.messages
      .map((message: { text: string }) => Number(/reply-(\d+)/.exec(message.text)![1]))

    const pageThrough = async ({ direction }: { direction: 'older' | 'newer' }) => {
      const found: number[] = []
      // Whether each page offers a cursor back the way the walk came: every page but the first.
      const back: boolean[] = []
      let cursor: string | undefined
      let page: Output

      do {
        page = await hydra.owner({
          args: [
            'hydra',
            'message',
            ...cursor ? [
              '--cursor',
              cursor,
            ] : [
              '--from',
              '2099-01-01T00:00:00.000Z',
              '--direction',
              direction,
            ],
            '--limit',
            '60',
          ],
        })
        found.push(...direction === 'older' ? numbers({ page }).reverse() : numbers({ page }))
        back.push(Boolean(direction === 'older' ? page.newer : page.older))
        cursor = direction === 'older' ? page.older : page.newer
      } while (cursor)

      expect(back[0]).toBe(false)
      expect(back.slice(1).every(Boolean)).toBe(true)

      return direction === 'older' ? found.reverse() : found
    }

    for (const direction of [
      'newer',
      'older',
    ] as const) {
      const found = await pageThrough({ direction })

      expect(found).toHaveLength(2500)
      expect(found[0]).toBe(0)
      expect(found.at(-1)).toBe(2499)
      expect(found.every((
        value,
        index,
      ) => index === 0 || value - found[index - 1] === 1)).toBe(true)
    }

    const history = await readAll({
      hydra,
      args: [
        '--since',
        'origin',
      ],
    })
    const told = history.flatMap(page => [...page.text.matchAll(/reply-(\d+) end/g)].map(match => Number(match[1])))
    expect(told).toHaveLength(2500)
    const count = await hydra.owner({
      args: [
        'hydra',
        'history',
        '--since',
        'origin',
        '--count',
      ],
    })
    expect(count.totalTokens).toBe(Math.ceil(Buffer.byteLength(history.map(page => page.text).join('\n\n')) / 4))
    expect(told[0]).toBe(0)
    expect(told.at(-1)).toBe(2499)
    expect(told.every((
      value,
      index,
    ) => index === 0 || value - told[index - 1] === 1)).toBe(true)
  },
  120_000,
)

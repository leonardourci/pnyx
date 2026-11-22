import { join } from 'node:path'
import { WORKER_RESUME } from '#workers/host.ts'
import { loadHydra } from '#app/store.ts'
import { readEvents } from '#app/event-log.ts'
import { nativeHome } from '#app/native-home.ts'
import { type NativeFact } from '#app/native-state.ts'
import { appendFileSync, readFileSync } from 'node:fs'
import { beforeAll, expect, onTestFinished, test } from 'vitest'
import { applyDecision } from '#app/decision.ts'
import { withWriter } from '#app/writer.ts'
import { decideSessionFacts } from '#workers/session-facts.ts'
import { transcriptPath } from '#workers/claude.ts'
import { startPnyx, until, type Hydra, type Output, type Pnyx } from './setup/pnyx.ts'

let pnyx: Pnyx

beforeAll(async () => {
  pnyx = await startPnyx()
})

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
  through: number
  // The words in log order: a brief is placed at its event, a reply between two events.
  order: string[]
  replySeq: ({ k }: { k: number }) => number
}

let fixture: Fixture | undefined

// The reply k sits half a second after this event of the bulk, so it takes the position of the event after it.
const replyAfter = ({ k }: { k: number }) => 1 + Math.floor(k * (EVENTS - 1) / REPLIES)

const inGap = ({ k }: { k: number }) => k >= GAP.from && k < GAP.to

// Events a second apart from 2099-01-01, a task brief every BRIEF_EVERY of them.
async function insertEvents({
  hydraId,
  card,
  count,
}: {
  hydraId: string
  first: number
  card: string
  count: number
}): Promise<void> {
  const home = nativeHome()

  for (let start = 1; start <= count; start += INSERT_BATCH) {
    const facts: NativeFact[] = []

    for (let n = start; n < Math.min(
      start + INSERT_BATCH,
      count + 1,
    ); n++) {
      const at = new Date(BASE + n * 1000).toISOString()
      const id = `bulk${n}`
      const brief = n % BRIEF_EVERY === 0
      const event = {
        v: 1,
        boardId: hydraId,
        actor: 'hook:claude',
        cardId: card,
        type: brief ? 'task.brief' : 'task.visibility',
        data: brief ? {
          before: `bulk ${n - 1}`,
          after: `bulk ${n}`,
        } : {
          before: false,
          after: false,
        },
      } as NativeFact['event']
      facts.push({
        at,
        by: 'daemon',
        t: brief ? 'brief' : 'visibility',
        id,
        event,
      })
      home.position({
        hydra: hydraId,
        scope: card,
        id,
      })
    }

    await home.files.changeTask({
      hydra: hydraId,
      task: card,
      decide: () => facts,
    })
  }

  home.reload({ hydra: hydraId })
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

  const first = loadHydra({ hydraId: hydra.id }).state.seq

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
    whileStopped: async () => {
      await insertEvents({
        hydraId: hydra.id,
        first,
        card: busy,
        count: EVENTS,
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
            id: `msg_bulk_${k}`,
            role: 'assistant',
            content: `reply-${k} ${long} end-${k}`,
            stop_reason: k === REPLIES - 1 ? 'end_turn' : null,
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
    get last() {
      return loadHydra({ hydraId: hydra.id }).state.eventIds.bulk1! - 1
    },
    get through() {
      return loadHydra({ hydraId: hydra.id }).state.seq
    },
    order,
    replySeq: ({ k }) => loadHydra({ hydraId: hydra.id }).state.eventIds[`bulk${replyAfter({ k }) + 1}`]!,
  }

  return fixture
}

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
  'a completed native worker stays finished when an earlier hook observation is retried after restart',
  async () => {
    const hydra = await pnyx.hydra()
    const key = 'hook-replay'
    const folder = hydra.folder({ name: key })
    const fullTask = async () => (await hydra.owner({
      args: [
        'task',
        'show',
        key,
        '--full',
      ],
    })).task
    await hydra.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--key',
        key,
        '--title',
        'Replay native hook',
        '--folder',
        folder,
      ],
    })
    const turn = pnyx.claude.plan({
      hydra: hydra.id,
      match: ({ text }) => text.includes('<pnyx-worker'),
      partial: 'Native work in progress',
      reply: 'Native work completed',
      hold: true,
    })
    onTestFinished(turn.release)
    await hydra.owner({
      args: [
        'task',
        'start',
        key,
      ],
    })
    await hydra.agent({ cwd: folder })
    const task = await fullTask()
    const id = `hook:${task.agent.sessionId}`
    const input = JSON.stringify({
      activity: 'working',
      agent: task.agent,
      source: {
        adapter: 'hooks',
        instanceId: 'claude',
        objectId: task.agent.sessionId,
        observedAt: new Date().toISOString(),
      },
    })
    const args = [
      'push',
      '--key',
      key,
      '--file',
      '-',
      '--event-id',
      id,
    ]
    await hydra.owner({
      args,
      input,
    })
    turn.release()
    await until({
      what: 'the native completion updates the task',
      check: async () => (await fullTask()).activity === 'finished',
    })
    const unexpectedResume = pnyx.claude.plan({
      hydra: hydra.id,
      text: WORKER_RESUME,
      hold: true,
      partial: 'Resumed work is still running',
    })
    onTestFinished(unexpectedResume.release)
    await pnyx.restart()
    expect((await fullTask()).activity).toBe('finished')
    await hydra.owner({
      args,
      input,
    })
    expect((await fullTask()).activity).toBe('finished')
    expect(readEvents({
      hydraId: hydra.id,
      ids: [id],
    })).toEqual([])
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
  'completed native replies with offset clocks remain in history after observations leave the log and after restart',
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
          id: 'msg_native-time-lookup',
          role: 'assistant',
          content: 'NATIVE-TIME-LOOKUP',
          stop_reason: 'end_turn',
        },
      })}\n`,
    )
    const through = await withWriter({
      hydraId: hydra.id,
      fn: ({ writer }) => {
        const native = Object.values(writer.state.sessions ?? {}).find(candidate =>
          candidate.agent.sessionId === session.id)

        if (!native) {
          throw new Error('The native Hydra session is missing')
        }

        for (const reading of [
          {
            activity: 'working',
            at: '2099-01-01T02:00:00.000+02:00',
          },
          {
            activity: 'finished',
            at: '2099-01-01T02:00:00.001+02:00',
          },
          {
            activity: 'working',
            at: '2099-01-01T00:00:04.999Z',
          },
          {
            activity: 'finished',
            at: '2099-01-01T00:00:05.001Z',
          },
        ] as const) {
          applyDecision({
            writer,
            decision: decideSessionFacts({
              state: writer.state,
              fields: {
                agent: native.agent,
                activity: reading.activity,
              },
              meta: {
                actor: 'pnyx',
                at: reading.at,
              },
            }),
          })
        }

        return writer.state.seq
      },
    })
    const live = await hydra.owner({
      args: [
        'hydra',
        'message',
        '--from',
        '1970-01-01T00:00:00Z',
      ],
    })
    expect(live.messages).toContainEqual(expect.objectContaining({ text: 'NATIVE-HISTORY-END' }))
    expect(live.messages).toContainEqual(expect.objectContaining({ text: 'NATIVE-TIME-LOOKUP' }))
    const at = await hydra.owner({
      args: [
        'hydra',
        'message',
        '--at',
        delayedAt,
      ],
    })
    expect(at.messages).toContainEqual(expect.objectContaining({ text: 'NATIVE-TIME-LOOKUP' }))
    const fixedArgs = [
      'hydra',
      'history',
      '--since',
      'origin',
      '--through',
      String(through),
    ]
    const fixed = await hydra.owner({ args: fixedArgs })
    expect(fixed.text).toContain('NATIVE-TIME-LOOKUP')
    await withWriter({
      hydraId: hydra.id,
      fn: ({ writer }) => writer.append({
        event: {
          v: 1,
          seq: writer.state.seq + 1,
          id: 'later-history-decision',
          at: '2099-01-01T00:00:10.000Z',
          actor: 'web',
          cardId: '$board',
          type: 'hydra.memory',
          data: {
            key: 'later-history',
            before: null,
            after: 'Unrelated later decision',
          },
        },
      }),
    })
    expect((await hydra.owner({ args: fixedArgs })).text).toContain('NATIVE-TIME-LOOKUP')
    await pnyx.restart()
    const restored = await hydra.owner({
      args: [
        'hydra',
        'message',
        '--from',
        '1970-01-01T00:00:00Z',
      ],
    })
    expect(restored.messages).toContainEqual(expect.objectContaining({ text: 'NATIVE-HISTORY-END' }))
    expect(restored.messages).toContainEqual(expect.objectContaining({ text: 'NATIVE-TIME-LOOKUP' }))
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
    const session = await hydra.chat({ text: 'Conversation before the saved inscribe boundary' })
    await until({
      what: 'the conversation before inscribe to finish',
      check: () => session.answered === 1 && !pnyx.home().scopes[hydra.id]?.queue?.chat?.working,
    })
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
    const overlapping = await hydra.owner({
      args: [
        'hydra',
        'inscribe',
        'start',
        '--key',
        'overlapping-pass',
      ],
    })
    expect(overlapping.notices).toContainEqual(expect.objectContaining({ reason: expect.stringContaining('still open') }))
    const duplicate = await hydra.owner({ args })
    expect(duplicate.notices ?? []).not.toContainEqual(expect.objectContaining({ reason: expect.stringContaining('still open') }))
    expect((await hydra.ownerRefused({
      args: [
        'hydra',
        'inscribe',
        'finish',
        '--key',
        'stored-pass',
        '--through',
        String(Number.MAX_SAFE_INTEGER),
      ],
    })).code).toBe('VALIDATION_ERROR')
    const completed = await hydra.owner({
      args: [
        'hydra',
        'inscribe',
        'finish',
        '--key',
        'stored-pass',
      ],
    })
    expect(completed.notices).toContainEqual(expect.objectContaining({ reason: expect.stringContaining('history snapshot') }))
    expect((await hydra.owner({
      args: [
        'hydra',
        'history',
        '--since',
        'last-inscribe',
        '--count',
      ],
    })).totalTokens).toBe(0)
    expect((await hydra.owner({
      args: [
        'hydra',
        'history',
        '--since',
        'stored-pass',
        '--count',
      ],
    })).totalTokens).toBe(0)
    const log = join(
      process.env.PNYX_HOME!,
      'hydras',
      hydra.id,
      'hydra.log',
    )
    const inscriptions = () => readFileSync(
      log,
      'utf8',
    ).trimEnd()
      .split('\n')
      .map(line => JSON.parse(line))
      .filter(fact => fact.inscribe?.key === 'stored-pass')
      .map(fact => fact.id)
    const beforeRestart = inscriptions()
    expect(beforeRestart).toHaveLength(2)
    const saved = readEvents({ hydraId: hydra.id }).map(event => ({
      id: event.id,
      type: event.type,
    }))
    expect(saved.map(event => event.type)).not.toContain('hydra.operation')
    await pnyx.restart()
    const retried = await hydra.owner({ args })
    expect(retried.duplicate).toBe('event id already applied; nothing appended')
    expect(retried.event).toEqual(first.event)
    expect(retried.milestone).toBe('stored-pass')
    expect(readEvents({ hydraId: hydra.id }).map(event => ({
      id: event.id,
      type: event.type,
    }))).toEqual(saved)
    expect(inscriptions()).toEqual(beforeRestart)
    expect(readFileSync(
      log,
      'utf8',
    )).toContain('Conversation before the saved inscribe boundary')
  },
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
      whileStopped: async () => {
        await insertEvents({
          hydraId: hydra.id,
          first,
          card: busy,
          count: DENSE_EVENTS,
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
              id: `msg_dense_${k}`,
              role: 'assistant',
              content: `reply-${k} end`,
              stop_reason: k === DENSE_REPLIES - 1 ? 'end_turn' : null,
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

    const count = await hydra.owner({
      args: [
        'hydra',
        'history',
        '--since',
        'origin',
        '--count',
      ],
    })
    // The role-prefixed fixture has 60,473 UTF-8 bytes, including separators between messages.
    expect(count.totalTokens).toBe(15_119)
  },
  120_000,
)

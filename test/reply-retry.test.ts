import { followUpSteering, steeringToFollow, STEERING_GRACE_MS, STEERING_RING_LIMIT, STEERING_DEFERRAL_LIMIT } from '../src/task-inbox/follow-up.ts'
import type { NotificationResult } from '../src/task-inbox/notice.ts'
import { notifySteering } from '../src/task-inbox/delivery.ts'
import { steeringClaim } from '../src/task-inbox/state.ts'
import { pausedDeclaration } from '../src/core/lifecycle.ts'
import { wakeReasons } from '../src/core/wake-reasons.ts'
import { acknowledgeSteering, enqueueSteering } from '../src/task-inbox/inbox.ts'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { commands } from '../src/cli/commands.ts'
import { followUpReplies } from '../src/cli/reply-retry.ts'
import { decidePush, decideReply, decideSession } from '../src/core/decide.ts'
import type { ReplyState } from '../src/core/model.ts'
import { withWriter } from '../src/app/writer.ts'
import { loadHydra } from '../src/app/store.ts'
import { readEvents } from '../src/app/event-log.ts'

let root = ''
let transcript = ''
const SENT = Date.parse('2026-10-22T10:00:00Z')
const MINUTE = 60_000

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(
    tmpdir(),
    'pnyx-reply-retry-',
  )))
  process.env.PNYX_HOME = join(
    root,
    'pnyx',
  )
  process.env.PNYX_SEMANTIC = 'off'
  const folder = join(
    root,
    'work',
  )
  mkdirSync(folder)
  transcript = join(
    root,
    'session.jsonl',
  )
  writeFileSync(
    transcript,
    '',
  )
  await commands.hydra([
    'create',
    'lab',
  ])
  await commands.task([
    'create',
    '--title',
    'Ship',
    '--key',
    'ship',
    '--hydra',
    'lab',
  ])
  withWriter({
    hydraId: 'lab',
    fn: ({ writer }) => {
      const meta = {
        at: new Date(SENT - MINUTE).toISOString(),
        actor: 'test',
      }
      const pushed = decidePush({
        state: writer.state,
        newCardId: `c${writer.state.seq + 1}`,
        key: 'terminal-session',
        input: {
          agent: {
            provider: 'claude-code',
            sessionId: 'terminal-session',
            cwd: folder,
            transcriptPath: transcript,
          },
          terminal: { tty: '/dev/ttys123' },
          activity: 'finished',
          source: {
            adapter: 'hooks',
            instanceId: 'claude',
            objectId: 'terminal-session',
            observedAt: meta.at,
          },
        },
        meta,
      })
      assert.ok('event' in pushed)
      writer.append({ event: pushed.event })
      const attached = decideSession({
        state: writer.state,
        ref: 'claude-code:terminal-session',
        task: writer.state.keys.ship!,
        meta,
      })
      assert.ok('event' in attached)
      writer.append({ event: attached.event })
    },
  })
})

afterEach(() => {
  rmSync(
    root,
    {
      recursive: true,
      force: true,
    },
  )
})

const task = () => {
  const state = loadHydra({ hydraId: 'lab' }).state

  return state.cards[state.keys.ship!]!
}

const receipt = ({
  reply,
  state,
  text,
  at,
  route = 'terminal:tmux',
  control,
  resumes,
}: {
  reply: string
  state: ReplyState
  text?: string
  at: number
  route?: string
  control?: boolean
  resumes?: boolean
}) => withWriter({
  hydraId: 'lab',
  fn: ({ writer }) => {
    const data = {
      reply,
      state,
      route,
    }

    if (resumes !== undefined) {
      Object.assign(
        data,
        { resumes },
      )
    }

    if (control) {
      Object.assign(
        data,
        { control },
      )
    }

    if (text) {
      Object.assign(
        data,
        { text },
      )
    }

    const decision = decideReply({
      state: writer.state,
      ref: task().id,
      data,
      meta: {
        at: new Date(at).toISOString(),
        actor: 'test',
      },
    })
    assert.ok('event' in decision)
    writer.append({ event: decision.event })
  },
})

// A resend that the route again cannot confirm, recorded as the reply command records it.
const unknownResend = ({ at }: { at: number }) => {
  const resent: string[] = []

  return {
    resent,
    resend: async ({
      retry,
    }: {
      card: string
      text: string
      retry: string
    }): Promise<ReplyState> => {
      resent.push(retry)
      receipt({
        reply: retry,
        state: 'queued',
        text: 'Rebase onto main',
        at,
      })
      receipt({
        reply: retry,
        state: 'delivery_unknown',
        at,
      })

      return 'delivery_unknown'
    },
  }
}

test(
  'an unconfirmed reply missing from the transcript is resent twice, then reported to Hydra without marking the card',
  async () => {
    receipt({
      reply: 'r1',
      state: 'queued',
      text: 'Rebase onto main',
      at: SENT,
    })
    receipt({
      reply: 'r1',
      state: 'delivery_unknown',
      at: SENT,
    })
    const reported: string[] = []
    const tried = new Map<string, number>()

    const unconfirmed = ({
      reply,
      text,
    }: {
      card: string
      reply: string
      text: string
    }) => {
      reported.push(`${reply}: ${text}`)
    }

    const early = unknownResend({ at: SENT })
    await followUpReplies({
      hydraId: 'lab',
      tried,
      resend: early.resend,
      unconfirmed,
      now: SENT + MINUTE / 2,
    })
    assert.deepEqual(
      early.resent,
      [],
      'a fresh send gets its grace period',
    )

    const first = unknownResend({ at: SENT + 2 * MINUTE })
    await followUpReplies({
      hydraId: 'lab',
      tried,
      resend: first.resend,
      unconfirmed,
      now: SENT + 2 * MINUTE,
    })
    const second = unknownResend({ at: SENT + 4 * MINUTE })
    await followUpReplies({
      hydraId: 'lab',
      tried,
      resend: second.resend,
      unconfirmed,
      now: SENT + 4 * MINUTE,
    })
    assert.deepEqual(
      [
        ...first.resent,
        ...second.resent,
      ],
      [
        'r1~retry1',
        'r1~retry2',
      ],
    )
    assert.deepEqual(
      reported,
      [],
    )

    const last = unknownResend({ at: SENT + 6 * MINUTE })
    await followUpReplies({
      hydraId: 'lab',
      tried,
      resend: last.resend,
      unconfirmed,
      now: SENT + 6 * MINUTE,
    })
    assert.deepEqual(
      last.resent,
      [],
    )
    assert.deepEqual(
      reported,
      ['r1: Rebase onto main'],
    )
    assert.deepEqual(
      task().attention,
      [],
      'the card stays unmarked',
    )

    // Past the reply's follow-up window nothing is resent or reported again, even on a card updated since.
    receipt({
      reply: 'r2',
      state: 'delivered',
      text: 'Thanks',
      at: SENT + 39 * MINUTE,
    })
    const late = unknownResend({ at: SENT + 40 * MINUTE })
    await followUpReplies({
      hydraId: 'lab',
      tried,
      resend: late.resend,
      unconfirmed,
      now: SENT + 40 * MINUTE,
    })
    assert.deepEqual(
      [
        late.resent.length,
        reported.length,
      ],
      [
        0,
        1,
      ],
    )
  },
)

test(
  'an unconfirmed reply found in the transcript is recorded delivered and never resent',
  async () => {
    await commands.task([
      'status',
      'ship',
      'paused',
      '--note',
      'Awaiting resumption',
      '--hydra',
      'lab',
    ])
    receipt({
      reply: 'r1',
      state: 'queued',
      resumes: true,
      text: 'Rebase   onto\nmain',
      at: SENT,
    })
    receipt({
      reply: 'r1',
      state: 'delivery_unknown',
      at: SENT,
    })
    assert.equal(
      task().status?.state,
      'paused',
    )
    appendFileSync(
      transcript,
      `${JSON.stringify({
        type: 'user',
        timestamp: new Date(SENT + 5000).toISOString(),
        message: {
          role: 'user',
          content: 'Rebase onto main',
        },
      })}\n`,
    )
    const fake = unknownResend({ at: SENT })
    const tried = new Map<string, number>()
    await followUpReplies({
      hydraId: 'lab',
      tried,
      resend: fake.resend,
      unconfirmed: () => assert.fail('a delivered reply is not reported'),
      now: SENT + 2 * MINUTE,
    })
    assert.equal(
      task().status?.state,
      'working',
    )
    assert.equal(
      task().column,
      loadHydra({ hydraId: 'lab' }).state.config?.columns.find(c => c.role === 'in_progress')?.id,
    )
    const count = task().statusLog?.length
    await followUpReplies({
      hydraId: 'lab',
      tried,
      resend: fake.resend,
      unconfirmed: () => assert.fail('confirmed'),
      now: SENT + 3 * MINUTE,
    })
    assert.equal(
      task().statusLog?.length,
      count,
    )
    assert.deepEqual(
      fake.resent,
      [],
    )
    assert.equal(
      task().replies?.find(reply => reply.id === 'r1')?.state,
      'delivered',
    )
  },
)

// A resend whose child failed before the reply command recorded anything.
const lostResend = () => {
  const resent: string[] = []

  return {
    resent,
    resend: async ({ retry }: { retry: string }): Promise<ReplyState> => {
      resent.push(retry)

      return 'delivery_unknown'
    },
  }
}

const unconfirmedReply = ({
  text,
  route,
  control,
}: {
  text: string
  route?: string
  control?: boolean
}) => {
  receipt({
    reply: 'r1',
    state: 'queued',
    text,
    at: SENT,
    route,
    control,
  })
  receipt({
    reply: 'r1',
    state: 'delivery_unknown',
    at: SENT,
    route,
    control,
  })
}

test(
  'resends that fail before their receipt still count, so the reply is reported after two',
  async () => {
    unconfirmedReply({ text: '- rebase onto main' })
    const tried = new Map<string, number>()
    const fake = lostResend()
    const reported: string[] = []

    for (const minute of [
      2,
      4,
      6,
    ]) {
      await followUpReplies({
        hydraId: 'lab',
        tried,
        resend: fake.resend,
        unconfirmed: ({ reply }) => {
          reported.push(reply)
        },
        now: SENT + minute * MINUTE,
      })
    }

    assert.deepEqual(
      [
        fake.resent,
        reported,
      ],
      [
        [
          'r1~retry1',
          'r1~retry2',
        ],
        ['r1'],
      ],
    )
  },
)

test(
  'control and Firstmate replies are never resent or reported',
  async () => {
    for (const reply of [
      {
        text: 'Use plan mode',
        control: true,
      },
      {
        text: 'Rebase onto main',
        route: 'firstmate:inbox',
      },
    ]) {
      unconfirmedReply(reply)
      const fake = lostResend()
      await followUpReplies({
        hydraId: 'lab',
        tried: new Map(),
        resend: fake.resend,
        unconfirmed: () => assert.fail(`${reply.text} is not reported`),
        now: SENT + 2 * MINUTE,
      })
      assert.deepEqual(
        fake.resent,
        [],
      )
    }
  },
)

test(
  'a short reply counts as arrived only when a message ends with it',
  async () => {
    unconfirmedReply({ text: 'yes' })
    appendFileSync(
      transcript,
      `${JSON.stringify({
        type: 'user',
        timestamp: new Date(SENT + 5000).toISOString(),
        message: {
          role: 'user',
          content: 'yes, and also fix the docs',
        },
      })}\n`,
    )
    const fake = lostResend()
    await followUpReplies({
      hydraId: 'lab',
      tried: new Map(),
      resend: fake.resend,
      unconfirmed: () => {},
      now: SENT + 2 * MINUTE,
    })
    assert.deepEqual(
      fake.resent,
      ['r1~retry1'],
    )
  },
)

test(
  'a resend that arrives marks the original delivered',
  async () => {
    unconfirmedReply({ text: 'Rebase onto main' })
    await followUpReplies({
      hydraId: 'lab',
      tried: new Map(),
      resend: async () => 'delivered',
      unconfirmed: () => assert.fail('a delivered resend is not reported'),
      now: SENT + 2 * MINUTE,
    })
    const arrived = readEvents({ hydraId: 'lab' }).findLast(event => event.type === 'card.replied')
    assert.deepEqual(
      [
        task().replies?.find(reply => reply.id === 'r1')?.state,
        arrived?.type === 'card.replied' && arrived.data.detail,
      ],
      [
        'delivered',
        'resent as r1~retry1',
      ],
    )
  },
)

test(
  'inbox-backed instructions stay pending instead of being confirmed or resent by transcript guessing',
  async () => {
    receipt({
      reply: 'durable',
      state: 'queued',
      text: 'Rebase onto main',
      at: SENT,
    })
    receipt({
      reply: 'durable',
      state: 'delivery_unknown',
      at: SENT,
    })
    withWriter({
      hydraId: 'lab',
      fn: ({ writer }) => {
        enqueueSteering({
          writer,
          ref: task().id,
          id: 'durable',
          reply: 'durable',
          text: 'Rebase onto main',
          source: 'test',
          meta: {
            actor: 'test',
            at: new Date(SENT).toISOString(),
          },
        })
      },
    })
    appendFileSync(
      transcript,
      `${JSON.stringify({
        type: 'user',
        timestamp: new Date(SENT).toISOString(),
        message: {
          role: 'user',
          content: 'Rebase onto main',
        },
      })}\n`,
    )
    let resent = 0
    let escalated = 0
    await followUpReplies({
      hydraId: 'lab',
      now: SENT + 2 * MINUTE,
      tried: new Map(),
      resend: async () => {
        resent++

        return 'delivered'
      },
      unconfirmed: () => {
        escalated++
      },
    })
    assert.equal(
      resent,
      0,
    )
    assert.equal(
      escalated,
      0,
    )
    assert.equal(
      task().replies!.find(reply => reply.id === 'durable')!.state,
      'delivery_unknown',
    )
    assert.equal(
      task().steering![0]!.ack,
      undefined,
    )
  },
)

function queuedSteer({ id = 'durable' }: { id?: string } = {}) {
  withWriter({
    hydraId: 'lab',
    fn: ({ writer }) => enqueueSteering({
      writer,
      ref: task().id,
      id,
      text: 'Olá 🌊\nSecond line',
      source: 'test',
      reply: id,
      meta: {
        at: new Date(SENT).toISOString(),
        actor: 'test',
      },
    }),
  })
}

function acknowledgeOldest() {
  withWriter({
    hydraId: 'lab',
    fn: ({ writer }) => {
      const card = writer.state.cards[task().id]!
      const message = card.steering!.find(message => !message.ack)!
      const claim = steeringClaim({ card })!
      const actor = `worker:${card.id}`
      acknowledgeSteering({
        writer,
        ref: card.id,
        id: message.id,
        ack: {
          at: new Date(SENT + MINUTE).toISOString(),
          actor,
          claim,
          outcome: 'incorporated',
        },
        meta: {
          at: new Date(SENT + MINUTE).toISOString(),
          actor,
        },
      })
    },
  })
}

for (const result of [
  'delivered',
  'unknown',
  'failed',
  'deferred',
  'gone',
] as const) {
  test(
    `durable ${result} notifications exhaust once, survive replay and keep the payload pending`,
    async () => {
      queuedSteer()
      let notifications = 0
      const limit = result === 'deferred' ? 2 : result === 'gone' ? 1 : 3

      const notify: typeof notifySteering = async () => {
        notifications++

        return {
          result,
          detail: `${result} route evidence`,
        }
      }

      for (let tick = 1; tick <= limit + 2; tick++) {
        await followUpSteering({
          hydraId: 'lab',
          now: SENT + tick * STEERING_GRACE_MS,
          notify,
        })
        rmSync(
          join(
            process.env.PNYX_HOME!,
            'hydras',
            'lab',
            'snapshot.json',
          ),
          { force: true },
        )
      }

      assert.equal(
        notifications,
        limit,
      )
      const message = task().steering![0]!
      assert.equal(
        message.ack,
        undefined,
      )
      assert.equal(
        message.text,
        'Olá 🌊\nSecond line',
      )
      assert.equal(
        message.recovery!.filter(attempt => attempt.result === 'exhausted').length,
        1,
      )
      const events = readEvents({ hydraId: 'lab' })
      const reasons = wakeReasons({
        state: loadHydra({ hydraId: 'lab' }).state,
        events,
      })
      assert.equal(
        reasons.filter(reason => reason.includes('instruction unread')).length,
        1,
      )
      assert.ok(reasons.some(reason => reason.includes('durable') && reason.includes('read')))
      assert.equal(
        steeringToFollow({ state: loadHydra({ hydraId: 'lab' }).state }),
        false,
      )
      acknowledgeOldest()
      queuedSteer({ id: 'next' })
      await followUpSteering({
        hydraId: 'lab',
        now: SENT + 20 * STEERING_GRACE_MS,
        notify,
      })
      assert.equal(
        notifications,
        limit + 1,
      )
      assert.equal(
        task().steering!.length,
        2,
      )
    },
  )
}

test(
  'acknowledgement racing recovery suppresses escalation and a duplicate scheduler cannot reserve twice',
  async () => {
    queuedSteer()
    let notifications = 0

    const notify: typeof notifySteering = async () => {
      notifications++
      await followUpSteering({
        hydraId: 'lab',
        now: SENT + STEERING_GRACE_MS,
        notify: async () => assert.fail('an in-flight reservation must prevent another notification'),
      })
      acknowledgeOldest()

      return {
        result: 'gone',
        detail: 'stale result after ack',
      }
    }

    await followUpSteering({
      hydraId: 'lab',
      now: SENT + STEERING_GRACE_MS,
      notify,
    })
    await followUpSteering({
      hydraId: 'lab',
      now: SENT + 10 * STEERING_GRACE_MS,
      notify,
    })
    assert.equal(
      notifications,
      1,
    )
    assert.equal(
      task().steering![0]!.ack!.outcome,
      'incorporated',
    )
    assert.equal(
      task().steering![0]!.recovery!.some(attempt => attempt.result === 'exhausted'),
      false,
    )
  },
)

test(
  'a crash after reserving consumes the durable budget, and younger instructions never bypass the oldest',
  async () => {
    queuedSteer()
    queuedSteer({ id: 'second' })
    const neverFinishes = new Promise<NotificationResult>(() => {})
    const inFlight = followUpSteering({
      hydraId: 'lab',
      now: SENT + STEERING_GRACE_MS,
      notify: () => neverFinishes,
    })
    rmSync(
      join(
        process.env.PNYX_HOME!,
        'hydras',
        'lab',
        'snapshot.json',
      ),
      { force: true },
    )
    const reserved = task().steering![0]!.recovery![0]!
    assert.equal(
      reserved.result,
      'reserved',
    )
    let notifications = 0

    for (let tick = 2; tick <= STEERING_RING_LIMIT + 2; tick++) {
      await followUpSteering({
        hydraId: 'lab',
        now: SENT + tick * STEERING_GRACE_MS,
        notify: async ({ message }) => {
          assert.equal(
            message,
            'durable',
          )
          notifications++

          return { result: 'delivered' }
        },
      })
    }

    assert.equal(
      notifications,
      2,
    )
    assert.equal(
      task().steering![1]!.recovery,
      undefined,
    )
    assert.equal(
      task().steering![0]!.recovery!.at(-1)!.result,
      'exhausted',
    )
    assert.ok(inFlight instanceof Promise)
  },
)

test(
  'an intentional hold consumes only the deferral budget and never wakes its worker',
  async () => {
    queuedSteer()
    await commands.task([
      'status',
      'ship',
      'paused',
      '--hold',
      '--reason',
      'Wait for owner',
      '--hydra',
      'lab',
    ])

    for (let tick = 1; tick <= STEERING_DEFERRAL_LIMIT + 1; tick++) {
      await followUpSteering({
        hydraId: 'lab',
        now: SENT + tick * STEERING_GRACE_MS,
      })
    }

    const card = task()
    assert.equal(
      card.steering![0]!.attempts.length,
      0,
    )
    assert.equal(
      card.steering![0]!.recovery!.at(-1)!.result,
      'exhausted',
    )
    assert.match(
      card.steering![0]!.recovery!.at(-1)!.detail!,
      /held/,
    )
    assert.equal(
      pausedDeclaration({ card })?.hold,
      true,
    )
  },
)

test(
  'recovery policy bounds are three notifications and two deferrals',
  () => {
    assert.equal(
      STEERING_RING_LIMIT,
      3,
    )
    assert.equal(
      STEERING_DEFERRAL_LIMIT,
      2,
    )
  },
)

test(
  'a stale dead-endpoint result cannot escalate a replacement assignment or reset the budget',
  async () => {
    queuedSteer()
    await followUpSteering({
      hydraId: 'lab',
      now: SENT + STEERING_GRACE_MS,
      notify: async () => {
        await commands.task([
          'detach',
          'ship',
          '--hydra',
          'lab',
        ])
        await commands.task([
          'attach',
          'ship',
          '--session',
          'claude-code:terminal-session',
          '--hydra',
          'lab',
        ])

        return {
          result: 'gone',
          detail: 'old endpoint disappeared',
        }
      },
    })
    assert.equal(
      task().steering![0]!.recovery![0]!.result,
      'unknown',
    )
    let notifications = 0

    for (let tick = 2; tick <= 4; tick++) {
      await followUpSteering({
        hydraId: 'lab',
        now: SENT + tick * STEERING_GRACE_MS,
        notify: async () => {
          notifications++

          return { result: 'delivered' }
        },
      })
    }

    assert.equal(
      notifications,
      2,
    )
    assert.equal(
      task().steering![0]!.recovery!.at(-1)!.result,
      'exhausted',
    )
  },
)

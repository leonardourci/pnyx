import { git, until } from '#test-harness/harness.ts'
import { startTask } from './start.ts'
import { createPaseoClient } from '@getpaseo/client'
import { createHost } from '#app/host.ts'
import { hostRequest } from '#app/host-request.ts'
import { offerHost } from '#app/server-state.ts'
import { hydraEvent } from '#hydra/hydra.ts'
import { settleCopy } from '#projects/copy-settle.ts'
import { notifySteering } from './inbox-delivery.ts'
import { followUpSteering, STEERING_GRACE_MS, STEERING_RING_LIMIT } from './inbox-follow-up.ts'
import type { NotificationResult } from './inbox-notice.ts'
import { enqueueSteering } from './inbox.ts'
import { steeringWorkerIdentity } from './steering.ts'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { commands } from '#app/cli.ts'
import { followUpReplies } from './reply-retry.ts'
import { decidePush } from '#tasks/push.ts'
import { decideReply } from './reply-rules.ts'
import { decideSession } from './sessions.ts'
import type { AgentSession, ReplyState } from './model.ts'
import { loadHydra } from '#app/store.ts'
import { readEvents } from '#app/event-log.ts'
import { withWriter } from '#app/writer.ts'
import { terminalPresence } from './presence.ts'
import { wakesHydra } from '#hydra/wake-reasons.ts'

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

const recorded = ({ record }: { record: unknown }) => appendFileSync(
  transcript,
  `${JSON.stringify(record)}\n`,
)

// One follow-up pass that fails if the reply is reported, returning what it resent.
const followUpOnce = async () => {
  const fake = lostResend()
  await followUpReplies({
    hydraId: 'lab',
    tried: new Map(),
    resend: fake.resend,
    unconfirmed: () => assert.fail('a reply is not reported on its first follow-up'),
    now: SENT + 2 * MINUTE,
  })

  return fake.resent
}

const arrivalDetail = () => {
  const arrived = readEvents({ hydraId: 'lab' }).findLast(event => event.type === 'card.replied')

  return arrived?.type === 'card.replied' ? arrived.data.detail : undefined
}

test(
  'a reply a Claude Code transcript records as a user turn is confirmed without a resend',
  async () => {
    unconfirmedReply({ text: 'Rebase onto main' })
    recorded({
      record: {
        type: 'user',
        timestamp: new Date(SENT + 5000).toISOString(),
        message: {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Rebase onto main',
            },
          ],
        },
      },
    })
    assert.deepEqual(
      await followUpOnce(),
      [],
    )
    assert.deepEqual(
      [
        task().replies?.find(reply => reply.id === 'r1')?.state,
        arrivalDetail(),
      ],
      [
        'delivered',
        'found in the session transcript',
      ],
    )
  },
)

test(
  'a reply a Codex transcript records as a user message is confirmed without a resend',
  async () => {
    unconfirmedReply({ text: 'Rebase onto main' })
    recorded({
      record: {
        type: 'response_item',
        timestamp: new Date(SENT + 5000).toISOString(),
        payload: {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'Rebase onto main',
            },
          ],
        },
      },
    })
    assert.deepEqual(
      await followUpOnce(),
      [],
    )
    assert.deepEqual(
      [
        task().replies?.find(reply => reply.id === 'r1')?.state,
        arrivalDetail(),
      ],
      [
        'delivered',
        'found in the session transcript',
      ],
    )
  },
)

test(
  'the reply text in an assistant turn or a Pnyx wake does not confirm it, so it is resent',
  async () => {
    unconfirmedReply({ text: 'Rebase onto main' })
    recorded({
      record: {
        type: 'assistant',
        timestamp: new Date(SENT + 5000).toISOString(),
        message: {
          content: [
            {
              type: 'text',
              text: 'Rebase onto main',
            },
          ],
        },
      },
    })
    recorded({
      record: {
        type: 'response_item',
        timestamp: new Date(SENT + 6000).toISOString(),
        payload: {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: '<pnyx-wake>Rebase onto main</pnyx-wake>',
            },
          ],
        },
      },
    })
    assert.deepEqual(
      await followUpOnce(),
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

test(
  'a busy worker retains its steering budget until it reads the instruction',
  async () => {
    queuedSteer()
    const original = task()
    const agent = original.agent
    assert.ok(agent)
    const probe = ({ session }: { session: AgentSession }) => terminalPresence({
      session,
      bootedAt: 0,
      run: () => 'ttys123',
    })
    withWriter({
      hydraId: 'lab',
      fn: ({ writer }) => {
        const working = decidePush({
          state: writer.state,
          key: original.key,
          input: {
            activity: 'working',
            terminal: {
              pid: '123',
              tty: '/dev/ttys123',
            },
            source: {
              adapter: 'hooks',
              instanceId: 'claude',
              objectId: 'terminal-session',
              observedAt: new Date(SENT).toISOString(),
            },
          },
          meta: {
            actor: 'test',
            at: new Date(SENT).toISOString(),
          },
        })
        assert.ok('event' in working)
        writer.append({ event: working.event })
      },
    })
    const notify = async (): Promise<NotificationResult> => assert.fail('a busy worker must not ring')
    await followUpSteering({
      hydraId: 'lab',
      now: SENT + STEERING_GRACE_MS,
      notify,
      probe,
    })
    withWriter({
      hydraId: 'lab',
      fn: ({ writer }) => {
        const finished = decidePush({
          state: writer.state,
          key: original.key,
          input: {
            activity: 'finished',
            source: {
              adapter: 'hooks',
              instanceId: 'claude',
              objectId: 'terminal-session',
              observedAt: new Date(SENT + STEERING_GRACE_MS).toISOString(),
            },
          },
          meta: {
            actor: 'test',
            at: new Date(SENT + STEERING_GRACE_MS).toISOString(),
          },
        })
        assert.ok('event' in finished)
        writer.append({ event: finished.event })
        const child = decidePush({
          state: writer.state,
          newCardId: 'child',
          key: 'child',
          input: {
            agent: {
              ...agent,
              agentId: 'helper',
            },
            activity: 'working',
            parent: original.id,
          },
          meta: {
            actor: 'test',
            at: new Date(SENT + STEERING_GRACE_MS).toISOString(),
          },
        })
        assert.ok('event' in child)
        writer.append({ event: child.event })
      },
    })
    await followUpSteering({
      hydraId: 'lab',
      now: SENT + 2 * STEERING_GRACE_MS,
      notify,
      probe,
    })
    await followUpSteering({
      hydraId: 'lab',
      now: SENT + 10 * STEERING_GRACE_MS,
      notify,
      probe,
    })
    assert.equal(
      task().steering![0]!.recovery,
      undefined,
    )
    await commands.task([
      'inbox',
      'read',
      original.id,
      '--hydra',
      'lab',
      '--actor',
      `worker:${original.id}`,
    ])
    await followUpSteering({
      hydraId: 'lab',
      now: SENT + 11 * STEERING_GRACE_MS,
      notify,
      probe,
    })
    assert.equal(
      task().steering![0]!.ack?.outcome,
      'read',
    )
    assert.equal(
      task().steering![0]!.recovery,
      undefined,
    )
    assert.equal(
      readEvents({ hydraId: 'lab' }).some(event => event.type === 'task.steering.recovery'),
      false,
    )
    queuedSteer({ id: 'orphaned' })
    await followUpSteering({
      hydraId: 'lab',
      now: SENT + 12 * STEERING_GRACE_MS,
      probe: ({ session }) => terminalPresence({
        session,
        bootedAt: 0,
        run: () => {
          throw new Error('process inspection unavailable')
        },
      }),
      notify,
    })
    assert.equal(
      task().steering![1]!.recovery,
      undefined,
    )
    await followUpSteering({
      hydraId: 'lab',
      now: SENT + 12 * STEERING_GRACE_MS,
      probe: ({ session }) => terminalPresence({
        session,
        bootedAt: 0,
        run: () => {
          throw Object.assign(
            new Error('process exited'),
            { status: 1 },
          )
        },
      }),
      notify: async () => ({
        result: 'gone',
        detail: 'worker process exited',
      }),
    })
    const recovery = task().steering![1]!.recovery
    assert.ok(recovery)
    assert.equal(
      recovery.at(-1)?.result,
      'exhausted',
    )
    const exhausted = readEvents({ hydraId: 'lab' }).find(event =>
      event.type === 'task.steering.recovery' && event.data.recovery.result === 'exhausted')
    assert.ok(exhausted)
    assert.equal(
      wakesHydra({
        state: loadHydra({ hydraId: 'lab' }).state,
        event: exhausted,
      }),
      true,
    )
  },
)

test(
  'busy deferrals keep the pause between attempts without exhausting the failure budget',
  async () => {
    queuedSteer()
    let notifications = 0

    const notify = async (): Promise<NotificationResult> => {
      notifications++

      return {
        result: 'deferred',
        busy: true,
      }
    }

    await followUpSteering({
      hydraId: 'lab',
      now: SENT + STEERING_GRACE_MS,
      notify,
    })
    await followUpSteering({
      hydraId: 'lab',
      now: SENT + 2 * STEERING_GRACE_MS - 1,
      notify,
    })
    assert.equal(
      notifications,
      1,
    )
    await followUpSteering({
      hydraId: 'lab',
      now: SENT + 2 * STEERING_GRACE_MS,
      notify,
    })
    await followUpSteering({
      hydraId: 'lab',
      now: SENT + 3 * STEERING_GRACE_MS,
      notify,
    })
    rmSync(join(
      process.env.PNYX_HOME!,
      'hydras',
      'lab',
      'snapshot.json',
    ))
    await followUpSteering({
      hydraId: 'lab',
      now: SENT + 4 * STEERING_GRACE_MS,
      notify,
    })
    assert.equal(
      notifications,
      4,
    )
    assert.deepEqual(
      task().steering![0]!.recovery!.map(attempt => attempt.result),
      [
        'deferred',
        'deferred',
        'deferred',
        'deferred',
      ],
    )
    assert.deepEqual(
      task().steering![0]!.recovery!.map(attempt => attempt.busy),
      [
        true,
        true,
        true,
        true,
      ],
    )
  },
)

test(
  'non-busy deferrals retain their bounded recovery',
  async () => {
    queuedSteer()
    let notifications = 0

    const notify = async (): Promise<NotificationResult> => {
      notifications++

      return { result: 'deferred' }
    }

    await followUpSteering({
      hydraId: 'lab',
      now: SENT + STEERING_GRACE_MS,
      notify,
    })
    await followUpSteering({
      hydraId: 'lab',
      now: SENT + 2 * STEERING_GRACE_MS,
      notify,
    })
    await followUpSteering({
      hydraId: 'lab',
      now: SENT + 3 * STEERING_GRACE_MS,
      notify,
    })
    assert.equal(
      notifications,
      2,
    )
    assert.deepEqual(
      task().steering![0]!.recovery!.map(attempt => attempt.result),
      [
        'deferred',
        'deferred',
        'exhausted',
      ],
    )
  },
)

test(
  'reading steering stops reminders while its work is still in progress, across replay',
  async () => {
    queuedSteer()
    const card = task()
    const read = [
      'inbox',
      'read',
      card.id,
      '--hydra',
      'lab',
    ]
    await commands.task(read)
    assert.equal(
      task().steering![0]!.ack,
      undefined,
    )
    await assert.rejects(
      () => commands.task([
        ...read,
        '--actor',
        'worker:someone-else',
      ]),
      { code: 'NOT_ALLOWED' },
    )
    const received = await commands.task([
      ...read,
      '--actor',
      `worker:${card.id}`,
    ])
    assert.match(
      JSON.stringify(received),
      /Olá 🌊/,
    )
    const acknowledged = task().steering![0]!.ack
    assert.equal(
      acknowledged?.outcome,
      'read',
    )
    const count = readEvents({ hydraId: 'lab' }).length
    await commands.task([
      ...read,
      '--actor',
      `worker:${card.id}`,
    ])
    assert.equal(
      readEvents({ hydraId: 'lab' }).length,
      count,
    )
    rmSync(join(
      process.env.PNYX_HOME!,
      'hydras',
      'lab',
      'snapshot.json',
    ))
    assert.deepEqual(
      task().steering![0]!.ack,
      acknowledged,
    )
    await followUpSteering({
      hydraId: 'lab',
      now: SENT + 10 * STEERING_GRACE_MS,
      notify: async () => assert.fail('a read instruction must not ring or exhaust'),
    })
    assert.equal(
      task().steering![0]!.recovery,
      undefined,
    )
    assert.deepEqual(
      task().statusLog,
      card.statusLog,
    )
    queuedSteer({ id: 'new-instruction' })
    let notified = ''
    await followUpSteering({
      hydraId: 'lab',
      now: SENT + 11 * STEERING_GRACE_MS,
      notify: async ({ message }) => {
        notified = message

        return { result: 'delivered' }
      },
    })
    assert.equal(
      notified,
      'new-instruction',
    )
  },
)

test(
  'an old hosted launch cannot read a replacement terminal worker’s instructions',
  async t => {
    const original = task()
    const meta = {
      actor: 'test',
      at: new Date().toISOString(),
    }
    const staleIdentity = steeringWorkerIdentity({
      state: loadHydra({ hydraId: 'lab' }).state,
      card: original,
    })
    assert.ok(staleIdentity)
    withWriter({
      hydraId: 'lab',
      fn: ({ writer }) => {
        const hosted = decidePush({
          state: writer.state,
          newCardId: 'unused',
          key: 'terminal-session',
          input: {
            agent: {
              ...original.agent!,
              host: 'pnyx',
            },
          },
          meta,
        })
        assert.ok('event' in hosted)
        writer.append({ event: hosted.event })
        const detached = decideSession({
          state: writer.state,
          ref: original.sessionIds![0]!,
          task: null,
          meta,
        })
        assert.ok('event' in detached)
        writer.append({ event: detached.event })
        const replacement = decidePush({
          state: writer.state,
          newCardId: `c${writer.state.seq + 1}`,
          key: 'replacement',
          input: {
            agent: {
              provider: 'claude-code',
              sessionId: 'replacement',
              cwd: root,
            },
            terminal: { tty: '/dev/ttys124' },
            activity: 'finished',
          },
          meta,
        })
        assert.ok('event' in replacement)
        writer.append({ event: replacement.event })
        const attached = decideSession({
          state: writer.state,
          ref: 'claude-code:replacement',
          task: original.id,
          meta,
        })
        assert.ok('event' in attached)
        writer.append({ event: attached.event })
      },
    })
    queuedSteer()
    process.env.PNYX_STEERING_WORKER = staleIdentity
    t.after(() => {
      delete process.env.PNYX_STEERING_WORKER
    })
    await assert.rejects(
      () => commands.task([
        'inbox',
        'read',
        original.id,
        '--hydra',
        'lab',
        '--actor',
        `worker:${original.id}`,
      ]),
      { code: 'STALE_CLAIM' },
    )
    assert.equal(
      task().steering![0]!.ack,
      undefined,
    )
    delete process.env.PNYX_STEERING_WORKER
    await commands.task([
      'inbox',
      'read',
      original.id,
      '--hydra',
      'lab',
      '--actor',
      `worker:${original.id}`,
    ])
    assert.equal(
      task().steering![0]!.ack?.outcome,
      'read',
    )
  },
)

test(
  'legacy incorporated and blocked acknowledgements retain their outcomes on replay',
  async () => {
    queuedSteer({ id: 'incorporated' })
    queuedSteer({ id: 'blocked' })
    const card = task()
    const claim = [
      '--hydra',
      'lab',
      '--actor',
      `worker:${card.id}`,
      '--session',
      card.sessionIds![0]!,
      '--generation',
      String(card.steeringGeneration ?? card.createdSeq),
    ]
    await commands.task([
      'inbox',
      'ack',
      card.id,
      'incorporated',
      ...claim,
      '--outcome',
      'incorporated',
    ])
    await commands.task([
      'inbox',
      'ack',
      card.id,
      'blocked',
      ...claim,
      '--outcome',
      'blocked',
      '--note',
      'Waiting for a decision',
    ])
    rmSync(join(
      process.env.PNYX_HOME!,
      'hydras',
      'lab',
      'snapshot.json',
    ))
    assert.deepEqual(
      task().steering!.map(message => message.ack?.outcome),
      [
        'incorporated',
        'blocked',
      ],
    )
    assert.equal(
      task().steering![1]!.ack?.note,
      'Waiting for a decision',
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
  'copy settlement refuses outside message I/O and command launches until their receipts are saved',
  async t => {
    const card = task()
    const folder = card.agent!.cwd!
    git({
      cwd: folder,
      args: [
        'init',
        '-q',
        '-b',
        'main',
      ],
    })
    git({
      cwd: folder,
      args: [
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'Base',
      ],
    })
    const message = withWriter({
      hydraId: 'lab',
      fn: ({ writer }) => {
        const meta = {
          actor: 'cli',
          at: new Date().toISOString(),
        }
        const attached = decidePush({
          state: writer.state,
          key: card.key,
          input: {
            agent: {
              ...card.agent!,
              paseoAgentId: 'outside-worker',
              paseoUrl: 'ws://127.0.0.1:1/ws',
            },
          },
          meta,
        })
        assert.ok('event' in attached)
        writer.append({ event: attached.event })
        const copied = hydraEvent({
          state: writer.state,
          cardId: card.id,
          meta,
          change: {
            type: 'task.copy',
            data: {
              before: card.copy ?? null,
              after: {
                path: folder,
                project: folder,
                via: 'command',
                base: 'main',
                state: 'active',
              },
            },
          },
        })
        assert.ok('event' in copied)
        writer.append({ event: copied.event })

        return enqueueSteering({
          writer,
          ref: card.id,
          id: 'outside-instruction',
          text: 'Continue the work',
          source: 'cli',
          meta,
        })
      },
    })
    const host = createHost({
      hydraId: 'lab',
      changed: () => {},
      wakeDelay: MINUTE,
    })
    const unoffer = offerHost({
      hydraId: 'lab',
      ask: ({ body }) => hostRequest({
        host,
        body,
      }),
    })
    let allowConnect = () => {}
    let allowSend = () => {}
    let allowClose = () => {}
    const connected = new Promise<void>(resolve => {
      allowConnect = resolve
    })
    const sent = new Promise<void>(resolve => {
      allowSend = resolve
    })
    const closed = new Promise<void>(resolve => {
      allowClose = resolve
    })
    let connecting = false
    let sending = false
    let closing = false
    let delivered = 0
    const client = createPaseoClient({ url: 'ws://127.0.0.1:1/ws' })
    const agent = client.agents.ref('outside-worker')
    t.mock.method(
      client.agents,
      'ref',
      () => agent,
    )
    t.mock.method(
      agent,
      'send',
      async () => {
        sending = true
        await sent
        delivered++
      },
    )
    t.mock.method(
      client,
      'close',
      async () => {
        closing = true
        await closed
      },
    )
    const notice = notifySteering({
      hydraId: 'lab',
      card: card.id,
      message: message.id,
      attempt: 'gated-notice',
      connectPaseo: async () => {
        connecting = true
        await connected

        return client
      },
    })
    let launchCompletion: Promise<unknown> | undefined

    try {
      const settle = () => settleCopy({
        hydraId: 'lab',
        ref: card.id,
        meta: {
          actor: 'cli',
          at: new Date().toISOString(),
        },
      })

      await until({
        what: 'outside connect to begin',
        check: () => connecting,
      })
      await assert.rejects(
        settle,
        { code: 'TASK_LEASED' },
      )
      assert.equal(
        task().copy?.state,
        'active',
      )
      allowConnect()
      await until({
        what: 'outside send to begin',
        check: () => sending,
      })
      await assert.rejects(
        settle,
        { code: 'TASK_LEASED' },
      )
      assert.equal(
        task().steering![0]!.attempts.length,
        0,
      )
      allowSend()
      await until({
        what: 'outside close to begin',
        check: () => closing,
      })
      await assert.rejects(
        settle,
        { code: 'TASK_LEASED' },
      )
      assert.equal(
        task().steering![0]!.attempts.length,
        0,
      )
      allowClose()
      assert.equal(
        (await notice).result,
        'delivered',
      )
      assert.equal(
        delivered,
        1,
      )
      assert.equal(
        task().steering![0]!.attempts[0]!.result,
        'delivered',
      )
      assert.equal(
        (await settle()).copy?.state,
        'removed',
      )
      await commands.task([
        'detach',
        card.id,
        '--hydra',
        'lab',
      ])
      withWriter({
        hydraId: 'lab',
        fn: ({ writer }) => {
          const copy = writer.state.cards[card.id]!.copy!
          const restored = hydraEvent({
            state: writer.state,
            cardId: card.id,
            meta: {
              actor: 'cli',
              at: new Date().toISOString(),
            },
            change: {
              type: 'task.copy',
              data: {
                before: copy,
                after: {
                  ...copy,
                  state: 'active',
                },
              },
            },
          })
          assert.ok('event' in restored)
          writer.append({ event: restored.event })
        },
      })
      const started = join(
        root,
        'command-started',
      )
      await commands.hydra([
        'set',
        '--hydra',
        'lab',
        '--command',
        'printf started > "$PNYX_FOLDER/../command-started"',
      ])
      const launch = startTask({
        hydraId: 'lab',
        task: card.id,
        via: 'command',
        folder,
        meta: {
          actor: 'pnyx',
          at: new Date().toISOString(),
        },
      })
      const observed = (async () => {
        try {
          return { result: await launch }
        } catch (error) {
          return { error }
        }
      })()
      launchCompletion = observed
      await assert.rejects(
        settle,
        { code: 'TASK_LEASED' },
      )
      const launched = await observed

      if (launched.error) {
        throw launched.error
      }

      assert.ok(launched.result)
      await until({
        what: 'outside command to start',
        check: () => existsSync(started),
      })
      assert.equal(
        task().launch?.via,
        'command',
      )
      assert.equal(
        (await settle()).copy?.state,
        'removed',
      )
    } finally {
      allowConnect()
      allowSend()
      allowClose()
      await notice.catch(() => undefined)
      await launchCompletion
      unoffer()
      host.close()
    }
  },
)

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { hydraEvent } from '#hydra/hydra.ts'
import { withWriter } from '#app/writer.ts'
import { declareTask } from '#tasks/declarations.ts'
import { HELPER_INSTRUCTIONS } from '#routine-helper/runner.ts'
import type { HelperChange } from '#routine-helper/state.ts'
import { REPLY_RULES } from '#hydra/wakes.ts'
import { permissionEvent } from '#workers/permission-rules.ts'
import type { PermissionRequest } from '#workers/model.ts'
import type { HydraEvent, HydraState } from '#app/model.ts'
import { until } from '#test-harness/harness.ts'
import { pnyx, type Scenario } from '#test-harness/pnyx.ts'

// Every helper prompt ends with its instructions, and a main wake with the reply rules.
const HELPER_PROMPT = HELPER_INSTRUCTIONS.slice(-40)
const MAIN_WAKE = `${REPLY_RULES.slice(-40)}</pnyx-wake>`

const routine = ({ tasks }: { tasks: string[] }) => JSON.stringify({
  outcomes: tasks.map(task => ({
    task,
    audience: 'routine',
    summary: 'Nudged the worker.',
  })),
})

// A Hydra with the helper on and these tasks; main has not run yet.
async function helperHydra({ keys }: { keys: string[] }) {
  const s = await pnyx.scenario()

  for (const key of keys) {
    await s.owner({
      args: [
        'task',
        'create',
        '--key',
        key,
        '--title',
        key,
      ],
    })
  }

  await s.owner({
    args: [
      'hydra',
      'set',
      '--helper',
      'claude',
      '--helper-model',
      'sonnet',
    ],
  })

  return s
}

// The owner's chat line starts a main turn that holds until released.
async function busyMain({
  s,
  text,
}: {
  s: Scenario
  text: string
}) {
  const held = pnyx.claude.plan({
    text,
    hold: true,
  })
  await s.chat({ text })
  await until({
    what: 'main to work on the owner’s message',
    check: () => s.state().cards[HYDRA_CARD]?.sessionActivity === 'working',
  })

  return held
}

// Workers declaring themselves blocked in one write, as a burst lands.
function declare({
  s,
  keys,
  status = 'blocked',
}: {
  s: Scenario
  keys: string[]
  status?: 'blocked' | 'needs_you'
}) {
  withWriter({
    hydraId: s.hydraId,
    fn: ({ writer }) => {
      for (const key of keys) {
        const decision = declareTask({
          state: writer.state,
          ref: key,
          status,
          note: 'The worker stopped.',
          meta: {
            at: new Date().toISOString(),
            actor: 'cli',
          },
        })
        assert.ok('event' in decision)
        writer.append({ event: decision.event })
      }
    },
  })
}

// A worker's message to Hydra: progress, or a report main must read.
function workerSays({
  s,
  key,
  text,
  kind,
}: {
  s: Scenario
  key: string
  text: string
  kind?: 'progress'
}) {
  const task = s.task({ key }).id
  withWriter({
    hydraId: s.hydraId,
    fn: ({ writer }) => {
      const decision = hydraEvent({
        state: writer.state,
        cardId: task,
        meta: {
          at: new Date().toISOString(),
          actor: `worker:${task}`,
        },
        change: {
          type: 'hydra.message',
          data: {
            action: 'send',
            hydra: 'hydra',
            task,
            text,
            ...(kind ? { kind } : {}),
          },
        },
      })
      assert.ok('event' in decision)
      writer.append({ event: decision.event })
    },
  })

  return s.events().findLast(event => event.type === 'hydra.message')!
}

const grants = ({ s }: { s: Scenario }) => s.events().flatMap(event => event.type === 'hydra.helper-started' ? [event.data] : [])

const finishes = ({ s }: { s: Scenario }) => s.events().flatMap(event => event.type === 'hydra.helper-finished' ? [event.data] : [])

// Main's next owner turn shows no wake reached it in between.
async function noWake({ s }: { s: Scenario }) {
  const hydra = await s.agent({ hydra: true })
  const turns = hydra.received.length
  await s.chat({ text: 'Anything new?' })
  await until({
    what: 'main to answer the owner',
    check: () => hydra.received.length === turns + 1 && s.state().cards[HYDRA_CARD]?.sessionActivity === 'finished',
  })
  assert.ok(hydra.received.every(text => !text.includes('<pnyx-wake>')))
}

test(
  'worker progress wakes nobody, while a routine change on the same task goes to the helper as main works',
  async () => {
    const s = await helperHydra({ keys: ['work'] })
    const task = s.task({ key: 'work' }).id
    const held = await busyMain({
      s,
      text: 'Watch the work.',
    })

    try {
      const progress = workerSays({
        s,
        key: 'work',
        text: 'Halfway through.',
        kind: 'progress',
      })
      pnyx.claude.plan({
        text: HELPER_PROMPT,
        reply: routine({ tasks: [task] }),
      })
      declare({
        s,
        keys: ['work'],
      })
      await until({
        what: 'the helper to finish while main still works',
        check: () => finishes({ s }).length === 1,
      })
      assert.equal(
        s.state().cards[HYDRA_CARD]?.sessionActivity,
        'working',
      )
      assert.deepEqual(
        grants({ s })[0]!.tasks,
        [task],
      )
      assert.ok(!grants({ s })[0]!.seqs.includes(progress.seq))
      assert.equal(
        finishes({ s })[0]!.error,
        undefined,
      )
    } finally {
      held.release()
    }

    await until({
      what: 'main to finish the owner’s turn',
      check: () => s.state().cards[HYDRA_CARD]?.sessionActivity === 'finished',
    })
    await noWake({ s })
  },
)

test(
  'a burst splits into capped helper batches without waking main',
  async () => {
    const keys = [
      'one',
      'two',
      'three',
      'four',
      'five',
    ]
    const s = await helperHydra({ keys })
    const tasks = keys.map(key => s.task({ key }).id)
    await s.chat({ text: 'Start watching.' })
    await until({
      what: 'main to finish its first turn',
      check: () => s.state().cards[HYDRA_CARD]?.sessionActivity === 'finished',
    })
    pnyx.claude.plan({
      text: HELPER_PROMPT,
      reply: routine({
        tasks: tasks.slice(
          0,
          3,
        ),
      }),
    })
    pnyx.claude.plan({
      text: HELPER_PROMPT,
      reply: routine({ tasks: tasks.slice(3) }),
    })
    declare({
      s,
      keys,
    })
    await until({
      what: 'both helper batches to finish',
      check: () => finishes({ s }).length === 2,
    })
    assert.deepEqual(
      grants({ s }).map(grant => grant.tasks),
      [
        tasks.slice(
          0,
          3,
        ),
        tasks.slice(3),
      ],
    )
    assert.ok(finishes({ s }).every(finish => !finish.error))
    await noWake({ s })
  },
)

test(
  'a failed helper batch reaches main once with its wakes and the work that waited behind it, then the helper takes routine work again',
  async () => {
    const keys = [
      'one',
      'two',
      'three',
      'four',
    ]
    const s = await helperHydra({ keys })
    const tasks = keys.map(key => s.task({ key }).id)
    const held = await busyMain({
      s,
      text: 'Keep an eye on things.',
    })
    const hydra = await s.agent({ hydra: true })

    try {
      pnyx.claude.plan({
        text: HELPER_PROMPT,
        reply: 'not an outcome record',
      })
      declare({
        s,
        keys,
      })
      await until({
        what: 'the helper batch to fail',
        check: () => finishes({ s })[0]?.error,
      })
    } finally {
      held.release()
    }

    await until({
      what: 'main to take the hand-back and finish',
      check: () => hydra.received.length === 2 && s.state().cards[HYDRA_CARD]?.sessionActivity === 'finished',
    })
    const wake = hydra.received[1]!
    assert.equal(
      grants({ s }).length,
      1,
    )
    assert.equal(
      wake.split('The routine helper handed back').length - 1,
      1,
    )

    for (const task of tasks) {
      assert.ok(wake.includes(`pnyx-task:${task}) declared: blocked`))
    }

    await until({
      what: 'main to acknowledge the hand-back',
      check: () => !Object.keys(s.state().helper?.runs ?? {}).length,
    })
    pnyx.claude.plan({
      text: HELPER_PROMPT,
      reply: routine({ tasks: [tasks[0]!] }),
    })
    declare({
      s,
      keys: ['one'],
      status: 'needs_you',
    })
    await until({
      what: 'the helper to take routine work again',
      check: () => finishes({ s }).length === 2,
    })
    assert.deepEqual(
      grants({ s })[1]!.tasks,
      [tasks[0]],
    )
  },
)

test(
  'the helper leaves a task to main while main’s wake turn handles it, and main’s wake carries the progress that waited',
  async () => {
    const s = await helperHydra({
      keys: [
        'work',
        'other',
      ],
    })
    const work = s.task({ key: 'work' }).id
    const other = s.task({ key: 'other' }).id
    await s.chat({ text: 'Start watching.' })
    const hydra = await s.agent({ hydra: true })
    await until({
      what: 'main to finish its first turn',
      check: () => s.state().cards[HYDRA_CARD]?.sessionActivity === 'finished',
    })
    const held = pnyx.claude.plan({
      text: MAIN_WAKE,
      hold: true,
    })

    try {
      workerSays({
        s,
        key: 'work',
        text: 'Halfway through.',
        kind: 'progress',
      })
      workerSays({
        s,
        key: 'work',
        text: 'The parser is done.',
      })
      await until({
        what: 'main to work on the report',
        check: () => hydra.received.length === 2 && s.state().cards[HYDRA_CARD]?.sessionActivity === 'working',
      })
      assert.ok(hydra.received[1]!.includes('Halfway through.'))
      pnyx.claude.plan({
        text: HELPER_PROMPT,
        reply: routine({ tasks: [other] }),
      })
      declare({
        s,
        keys: [
          'work',
          'other',
        ],
      })
      await until({
        what: 'the helper to finish the other task',
        check: () => finishes({ s }).length === 1,
      })
      assert.deepEqual(
        grants({ s })[0]!.tasks,
        [other],
      )
      pnyx.claude.plan({
        text: HELPER_PROMPT,
        reply: routine({ tasks: [work] }),
      })
    } finally {
      held.release()
    }

    await until({
      what: 'the helper to take the task once main’s turn ends',
      check: () => finishes({ s }).length === 2,
    })
    assert.deepEqual(
      grants({ s })[1]!.tasks,
      [work],
    )
  },
)

test(
  'the helper may answer a plain tool permission but not one that asks a question or carries an answer',
  async () => {
    const s = await helperHydra({ keys: ['work'] })
    const task = s.task({ key: 'work' }).id
    const append = ({ event }: {
      event({ state }: { state: HydraState }): HydraEvent
    }) => withWriter({
      hydraId: s.hydraId,
      fn: ({ writer }) => writer.append({ event: event({ state: writer.state }) }),
    })
    const pending = ({
      id,
      request,
    }: {
      id: string
      request: Partial<PermissionRequest>
    }) => append({
      event: ({ state }) => permissionEvent({
        state,
        card: state.cards[task]!,
        request: {
          id,
          session: 'worker-session',
          tool: 'Bash',
          input: { command: 'ls' },
          status: 'pending',
          ...request,
        },
        meta: {
          at: new Date().toISOString(),
          actor: 'pnyx',
        },
      }),
    })
    const helperChange = ({ change }: { change: HelperChange }) => append({
      event: ({ state }) => {
        const decision = hydraEvent({
          state,
          cardId: HYDRA_CARD,
          meta: {
            at: new Date().toISOString(),
            actor: 'pnyx',
          },
          change,
        })
        assert.ok('event' in decision)

        return decision.event
      },
    })
    pending({
      id: 'tool',
      request: {},
    })
    pending({
      id: 'question',
      request: {
        tool: 'AskUserQuestion',
        questions: [
          {
            question: 'Which parser?',
            options: [{ label: 'New' }],
          },
        ],
      },
    })
    helperChange({
      change: {
        type: 'hydra.helper-started',
        data: {
          id: 'grant',
          tasks: [task],
          prompt: '',
          seqs: [],
        },
      },
    })
    // The helper's own pnyx-axi environment for its granted batch.
    const helper = s.as({
      agent: {
        id: 'helper',
        resumed: false,
        cwd: process.cwd(),
        env: {
          ...process.env,
          PNYX_ACTOR: 'helper:grant',
          PNYX_HYDRA: s.hydraId,
        },
        received: [],
      },
    })
    const answer = ({
      request,
      extra = [],
    }: {
      request: string
      extra?: string[]
    }) => helper.refusal({
      args: [
        'task',
        'permission',
        task,
        request,
        'allow',
        '--reason',
        'In scope.',
        ...extra,
      ],
    })

    try {
      assert.equal(
        (await answer({ request: 'question' })).code,
        'MAIN_ONLY',
      )
      assert.equal(
        (await answer({
          request: 'tool',
          extra: [
            '--answer',
            '{}',
          ],
        })).code,
        'MAIN_ONLY',
      )
      // No live worker waits on it, so a permitted answer finds the request expired rather than refused.
      assert.equal(
        (await answer({ request: 'tool' })).code,
        'PERMISSION_CLOSED',
      )
      assert.equal(
        s.task({ key: 'work' }).permissions?.find(request => request.id === 'question')?.status,
        'pending',
      )
    } finally {
      helperChange({
        change: {
          type: 'hydra.helper-finished',
          data: {
            batch: 'grant',
            outcomes: [],
          },
        },
      })
    }
  },
)

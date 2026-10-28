import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { hydraEvent } from '#hydra/hydra.ts'
import { withWriter } from '#app/writer.ts'
import { declareTask } from '#tasks/declarations.ts'
import { HELPER_TASKS } from '#routine-helper/route.ts'
import { until } from '#test-harness/harness.ts'
import { pnyx, type Scenario } from '#test-harness/pnyx.ts'

// Every helper prompt ends with its instructions, and no main prompt does.
const HELPER_PROMPT = 'quiet progress belongs to routine.'

const routine = ({ tasks }: { tasks: string[] }) => JSON.stringify({
  outcomes: tasks.map(task => ({
    task,
    audience: 'routine',
    summary: 'Nudged the worker.',
  })),
})

// A Hydra with the helper on, main started once, and these tasks.
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
function blocked({
  s,
  keys,
}: {
  s: Scenario
  keys: string[]
}) {
  withWriter({
    hydraId: s.hydraId,
    fn: ({ writer }) => {
      for (const key of keys) {
        const decision = declareTask({
          state: writer.state,
          ref: key,
          status: 'blocked',
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

const grants = ({ s }: { s: Scenario }) => s.events().flatMap(event => event.type === 'hydra.helper-started' ? [event.data] : [])

const finishes = ({ s }: { s: Scenario }) => s.events().flatMap(event => event.type === 'hydra.helper-finished' ? [event.data] : [])

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
      withWriter({
        hydraId: s.hydraId,
        fn: ({ writer }) => {
          const decision = hydraEvent({
            state: writer.state,
            cardId: HYDRA_CARD,
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
                kind: 'progress',
                text: 'Halfway through.',
              },
            },
          })
          assert.ok('event' in decision)
          writer.append({ event: decision.event })
        },
      })
      const progress = s.events().findLast(event => event.type === 'hydra.message')!
      pnyx.claude.plan({
        text: HELPER_PROMPT,
        reply: routine({ tasks: [task] }),
      })
      blocked({
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
      const [grant] = grants({ s })
      assert.deepEqual(
        grant!.tasks,
        [task],
      )
      assert.ok(!grant!.seqs.includes(progress.seq))
      assert.equal(
        finishes({ s })[0]!.error,
        undefined,
      )
    } finally {
      held.release()
    }

    const hydra = await s.agent({ hydra: true })
    await until({
      what: 'main to finish the owner’s turn',
      check: () => s.state().cards[HYDRA_CARD]?.sessionActivity === 'finished',
    })
    await s.chat({ text: 'Anything new?' })
    await until({
      what: 'main to answer the next message',
      check: () => hydra.received.length === 2 && s.state().cards[HYDRA_CARD]?.sessionActivity === 'finished',
    })
    assert.ok(hydra.received.every(text => !text.includes('<pnyx-wake>')))
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
    const hydra = await s.agent({ hydra: true })
    await until({
      what: 'main to finish its first turn',
      check: () => s.state().cards[HYDRA_CARD]?.sessionActivity === 'finished',
    })
    pnyx.claude.plan({
      text: HELPER_PROMPT,
      reply: routine({
        tasks: tasks.slice(
          0,
          HELPER_TASKS,
        ),
      }),
    })
    pnyx.claude.plan({
      text: HELPER_PROMPT,
      reply: routine({ tasks: tasks.slice(HELPER_TASKS) }),
    })
    blocked({
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
          HELPER_TASKS,
        ),
        tasks.slice(HELPER_TASKS),
      ],
    )
    assert.ok(finishes({ s }).every(finish => !finish.error))
    assert.equal(
      hydra.received.length,
      1,
    )
  },
)

test(
  'a failed helper batch reaches main once, with the routine work that waited behind it',
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
      blocked({
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

    for (const task of tasks.slice(
      0,
      HELPER_TASKS,
    )) {
      assert.ok(wake.includes(`pnyx-task:${task}`))
    }

    assert.match(
      wake,
      new RegExp(`pnyx-task:${tasks[HELPER_TASKS]}\\) declared: blocked`),
    )
    await until({
      what: 'main to acknowledge the hand-back',
      check: () => !Object.keys(s.state().helper?.runs ?? {}).length,
    })
  },
)

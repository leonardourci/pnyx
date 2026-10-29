import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { commands } from '#app/cli.ts'
import { hydraDir } from '#app/home-migration.ts'
import { hydraEvent } from '#hydra/hydra.ts'
import { withWriter } from '#app/writer.ts'
import { declareTask } from '#tasks/declarations.ts'
import { HELPER_INSTRUCTIONS } from '#routine-helper/runner.ts'
import type { HelperChange } from '#routine-helper/state.ts'
import { permissionEvent } from '#workers/permission-rules.ts'
import type { PermissionRequest } from '#workers/model.ts'
import type { Decision, HydraEvent, HydraState } from '#app/model.ts'
import { openPage, until } from '#test-harness/harness.ts'
import { pnyx, type Scenario } from '#test-harness/pnyx.ts'

// Every helper prompt ends with its instructions, and every main wake with a closing wake block.
const HELPER_PROMPT = HELPER_INSTRUCTIONS.slice(-40)
const MAIN_WAKE = '</pnyx-wake>'

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

type Step = ({ state }: { state: HydraState }) => Decision

// Changes landing in one write, as a burst does.
function inOneWrite({
  s,
  steps,
}: {
  s: Scenario
  steps: Step[]
}) {
  withWriter({
    hydraId: s.hydraId,
    fn: ({ writer }) => {
      for (const step of steps) {
        const decision = step({ state: writer.state })
        assert.ok('event' in decision)
        writer.append({ event: decision.event })
      }
    },
  })
}

const declared = ({
  key,
  status = 'blocked',
  until: end,
}: {
  key: string
  status?: 'blocked' | 'needs_you' | 'paused'
  until?: string
}): Step => ({ state }) => declareTask({
  state,
  ref: key,
  status,
  note: 'The worker stopped.',
  until: end,
  meta: {
    at: new Date().toISOString(),
    actor: 'cli',
  },
})

// A worker's message to Hydra: progress, a question, or a report main must read.
const says = ({
  s,
  key,
  text,
  kind,
  ask,
}: {
  s: Scenario
  key: string
  text: string
  kind?: 'progress'
  ask?: string
}): Step => ({ state }) => {
  const task = s.task({ key }).id

  return hydraEvent({
    state,
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
        ...(ask ? { ask } : {}),
      },
    },
  })
}

function declare({
  s,
  keys,
  status,
}: {
  s: Scenario
  keys: string[]
  status?: 'blocked' | 'needs_you'
}) {
  inOneWrite({
    s,
    steps: keys.map(key => declared({
      key,
      status,
    })),
  })
}

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
  inOneWrite({
    s,
    steps: [
      says({
        s,
        key,
        text,
        kind,
      }),
    ],
  })

  return s.events().findLast(event => event.type === 'hydra.message')!
}

const grants = ({ s }: { s: Scenario }) => s.events().flatMap(event => event.type === 'hydra.helper-started' ? [event.data] : [])

const finishes = ({ s }: { s: Scenario }) => s.events().flatMap(event => event.type === 'hydra.helper-finished' ? [event.data] : [])

// The helper's next batch and main's next wake hold only the changes the server has read.
async function serverRead({ s }: { s: Scenario }) {
  const seq = s.state().seq
  const page = await openPage({
    port: pnyx.port(),
    hydraId: s.hydraId,
  })

  try {
    await page.shows({
      what: 'the server to read the latest change',
      check: ({ state }) => state.seq >= seq,
    })
  } finally {
    page.close()
  }
}

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
  'a burst splits into capped helper batches; owner outcomes reach main while the helper works, and main keeps those tasks during that turn',
  async () => {
    const keys = [
      'one',
      'two',
      'three',
      'four',
      'five',
      'six',
      'seven',
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
      reply: JSON.stringify({
        outcomes: tasks.slice(
          0,
          3,
        ).map(task => ({
          task,
          audience: 'owner',
          summary: 'A parser choice waits on the owner.',
        })),
      }),
    })
    const second = pnyx.claude.plan({
      text: HELPER_PROMPT,
      reply: routine({
        tasks: tasks.slice(
          3,
          6,
        ),
      }),
      hold: true,
    })
    const outcomesTurn = pnyx.claude.plan({
      text: MAIN_WAKE,
      hold: true,
    })
    pnyx.claude.plan({
      text: HELPER_PROMPT,
      reply: routine({ tasks: [tasks[6]!] }),
    })
    pnyx.claude.plan({
      text: HELPER_PROMPT,
      reply: routine({ tasks: [tasks[0]!] }),
    })

    try {
      declare({
        s,
        keys,
      })
      await until({
        what: 'main to get the owner outcomes while the second batch still runs',
        check: () => hydra.received.length === 2 && grants({ s }).length === 2
          && finishes({ s }).length === 1,
      })
      assert.match(
        hydra.received[1]!,
        /Helper outcomes to relay/,
      )
      declare({
        s,
        keys: ['one'],
        status: 'needs_you',
      })
      second.release()
      await until({
        what: 'the third batch to finish while main relays the outcomes',
        check: () => finishes({ s }).length === 3,
      })
      assert.equal(
        s.state().cards[HYDRA_CARD]?.sessionActivity,
        'working',
      )
    } finally {
      second.release()
      outcomesTurn.release()
    }

    await until({
      what: 'the helper to take the first task once main’s turn ends',
      check: () => finishes({ s }).length === 4,
    })
    assert.deepEqual(
      grants({ s }).map(grant => grant.tasks),
      [
        tasks.slice(
          0,
          3,
        ),
        tasks.slice(
          3,
          6,
        ),
        [tasks[6]],
        [tasks[0]],
      ],
    )
    assert.ok(finishes({ s }).every(finish => !finish.error))
    assert.ok(hydra.received.every(text => !text.includes('declared: blocked')))
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
  'main’s wake takes only main’s updates: the helper’s overflow waits for its next batch, and a task main handles waits for main’s turn to end',
  async () => {
    const extra = [
      'a',
      'b',
      'c',
      'd',
    ]
    const s = await helperHydra({
      keys: [
        'work',
        'other',
        ...extra,
      ],
    })
    const [
      work,
      other,
      a,
      b,
      c,
      d,
    ] = [
      'work',
      'other',
      ...extra,
    ].map(key => s.task({ key }).id)
    await s.chat({ text: 'Start watching.' })
    const hydra = await s.agent({ hydra: true })
    await until({
      what: 'main to finish its first turn',
      check: () => s.state().cards[HYDRA_CARD]?.sessionActivity === 'finished',
    })
    const wake = pnyx.claude.plan({
      text: MAIN_WAKE,
      hold: true,
    })
    const first = pnyx.claude.plan({
      text: HELPER_PROMPT,
      reply: routine({
        tasks: [
          a!,
          b!,
          c!,
        ],
      }),
      hold: true,
    })
    pnyx.claude.plan({
      text: HELPER_PROMPT,
      reply: routine({
        tasks: [
          d!,
          other!,
        ],
      }),
    })
    pnyx.claude.plan({
      text: HELPER_PROMPT,
      reply: routine({ tasks: [work!] }),
    })

    try {
      workerSays({
        s,
        key: 'work',
        text: 'Halfway through.',
        kind: 'progress',
      })
      inOneWrite({
        s,
        steps: [
          says({
            s,
            key: 'work',
            text: 'The parser is done.',
          }),
          ...extra.map(key => declared({ key })),
        ],
      })
      await until({
        what: 'main to work on the report while the helper holds the first batch',
        check: () => hydra.received.length === 2 && s.state().cards[HYDRA_CARD]?.sessionActivity === 'working'
          && grants({ s }).length === 1,
      })
      assert.ok(hydra.received[1]!.includes('Halfway through.'))
      assert.ok(!hydra.received[1]!.includes('declared: blocked'))
      declare({
        s,
        keys: [
          'work',
          'other',
        ],
      })
      await serverRead({ s })
      first.release()
      await until({
        what: 'the helper to take the overflow and the other task',
        check: () => finishes({ s }).length === 2,
      })
    } finally {
      first.release()
      wake.release()
    }

    await until({
      what: 'the helper to take the task once main’s turn ends',
      check: () => finishes({ s }).length === 3,
    })
    assert.deepEqual(
      grants({ s }).map(grant => grant.tasks),
      [
        [
          a,
          b,
          c,
        ],
        [
          d,
          other,
        ],
        [work],
      ],
    )
  },
)

test(
  'a stall alarm leaves a task to main while main has an update for it waiting',
  async () => {
    const s = await helperHydra({
      keys: [
        'work',
        'other',
      ],
    })
    const other = s.task({ key: 'other' }).id
    const held = await busyMain({
      s,
      text: 'Hold on.',
    })
    pnyx.claude.plan({
      text: HELPER_PROMPT,
      reply: routine({ tasks: [other] }),
    })

    try {
      const past = new Date(Date.now() - 60_000).toISOString()
      inOneWrite({
        s,
        steps: [
          declared({
            key: 'work',
            status: 'paused',
            until: past,
          }),
          declared({
            key: 'other',
            status: 'paused',
            until: past,
          }),
          says({
            s,
            key: 'work',
            text: 'The parser is done.',
          }),
        ],
      })
      await until({
        what: 'the ended waits to reach the helper',
        check: () => finishes({ s }).length === 1,
      })
      assert.deepEqual(
        grants({ s }).map(grant => grant.tasks),
        [[other]],
      )
    } finally {
      held.release()
    }
  },
)

test(
  'many open questions on one task keep the helper’s prompt within its budget, and those it left reach main with its owner outcome',
  async () => {
    const s = await helperHydra({
      keys: [
        'seed',
        'work',
        'report',
      ],
    })
    const seed = s.task({ key: 'seed' }).id
    const work = s.task({ key: 'work' }).id
    await s.chat({ text: 'Start watching.' })
    const hydra = await s.agent({ hydra: true })
    await until({
      what: 'main to finish its first turn',
      check: () => s.state().cards[HYDRA_CARD]?.sessionActivity === 'finished',
    })
    const seedTurn = pnyx.claude.plan({
      text: HELPER_PROMPT,
      reply: routine({ tasks: [seed] }),
      hold: true,
    })
    const workTurn = pnyx.claude.plan({
      text: HELPER_PROMPT,
      reply: JSON.stringify({
        outcomes: [
          {
            task: work,
            audience: 'owner',
            summary: 'Ask the owner which parser to use.',
          },
        ],
      }),
      hold: true,
    })

    try {
      declare({
        s,
        keys: ['seed'],
      })
      await until({
        what: 'the helper to hold the seed batch',
        check: () => grants({ s }).length === 1,
      })

      for (let index = 0; index < 120; index++) {
        await commands.task([
          'ask',
          'work',
          '--question',
          `Question ${index}: ${'Which parser owns dates? '.repeat(11)}`,
          '--actor',
          `worker:${work}`,
          '--hydra',
          s.hydraId,
        ])
      }

      // An unrelated report wakes main past the questions, which wait parked for the helper.
      workerSays({
        s,
        key: 'report',
        text: 'The parser is done.',
      })
      await until({
        what: 'main to finish the unrelated report',
        check: () => hydra.received.length === 2 && s.state().cards[HYDRA_CARD]?.sessionActivity === 'finished',
      })
      assert.ok(!hydra.received[1]!.includes(`task="${work}"`))
      seedTurn.release()
      await until({
        what: 'the helper to take the questions',
        check: () => grants({ s }).length === 2,
      })
      const batch = grants({ s })[1]!
      assert.ok(batch.prompt.length <= 24_000)
      assert.match(
        batch.prompt,
        /Open decisions \(120\):/,
      )
      assert.match(
        batch.prompt,
        /- 110 more left out of this batch/,
      )
      assert.ok(batch.seqs.length < 120)
      workTurn.release()
      await until({
        what: 'main to relay the outcome with every question the helper left',
        check: () => hydra.received.length === 3 && s.state().cards[HYDRA_CARD]?.sessionActivity === 'finished',
      })
      const relay = hydra.received[2]!
      assert.match(
        relay,
        /Helper outcomes to relay/,
      )
      assert.equal(
        relay.split(`task="${work}"`).length - 1,
        120 - batch.seqs.length,
      )
      assert.equal(
        grants({ s }).length,
        2,
      )
    } finally {
      seedTurn.release()
      workTurn.release()
    }
  },
)

test(
  'turning the helper off hands its waiting overflow to main',
  async () => {
    const keys = [
      'one',
      'two',
      'three',
      'four',
      'five',
      'report',
    ]
    const s = await helperHydra({ keys })
    const tasks = keys.map(key => s.task({ key }).id)
    await s.chat({ text: 'Start watching.' })
    const hydra = await s.agent({ hydra: true })
    await until({
      what: 'main to finish its first turn',
      check: () => s.state().cards[HYDRA_CARD]?.sessionActivity === 'finished',
    })
    const first = pnyx.claude.plan({
      text: HELPER_PROMPT,
      reply: routine({
        tasks: tasks.slice(
          0,
          3,
        ),
      }),
      hold: true,
    })

    try {
      inOneWrite({
        s,
        steps: [
          ...keys.slice(
            0,
            5,
          ).map(key => declared({ key })),
          says({
            s,
            key: 'report',
            text: 'The parser is done.',
          }),
        ],
      })
      await until({
        what: 'main to finish the report',
        check: () => hydra.received.length === 2 && s.state().cards[HYDRA_CARD]?.sessionActivity === 'finished',
      })
      assert.ok(!hydra.received[1]!.includes('declared: blocked'))
      await s.owner({
        args: [
          'hydra',
          'set',
          '--helper',
          'off',
        ],
      })
    } finally {
      first.release()
    }

    await until({
      what: 'main to take the overflow',
      check: () => hydra.received.length === 3 && s.state().cards[HYDRA_CARD]?.sessionActivity === 'finished',
    })

    for (const task of tasks.slice(
      3,
      5,
    )) {
      assert.ok(hydra.received[2]!.includes(`pnyx-task:${task}) declared: blocked`))
    }

    await s.chat({ text: 'Anything new?' })
    await until({
      what: 'main to answer the owner',
      check: () => hydra.received.length === 4 && s.state().cards[HYDRA_CARD]?.sessionActivity === 'finished',
    })
    assert.ok(!hydra.received[3]!.includes('<pnyx-wake>'))
    assert.equal(
      grants({ s }).length,
      1,
    )
  },
)

test(
  'a task whose owner outcome main has not relayed stays main’s, so main can act on it',
  async () => {
    const s = await helperHydra({ keys: ['work'] })
    const work = s.task({ key: 'work' }).id
    await s.chat({ text: 'Start watching.' })
    const hydra = await s.agent({ hydra: true })
    await until({
      what: 'main to finish its first turn',
      check: () => s.state().cards[HYDRA_CARD]?.sessionActivity === 'finished',
    })
    const first = pnyx.claude.plan({
      text: HELPER_PROMPT,
      reply: JSON.stringify({
        outcomes: [
          {
            task: work,
            audience: 'owner',
            summary: 'Ask the owner which parser to use.',
          },
        ],
      }),
      hold: true,
    })
    const relay = pnyx.claude.plan({
      text: MAIN_WAKE,
      hold: true,
    })

    try {
      declare({
        s,
        keys: ['work'],
      })
      await until({
        what: 'the helper to hold the first batch',
        check: () => grants({ s }).length === 1,
      })
      inOneWrite({
        s,
        steps: [
          says({
            s,
            key: 'work',
            text: 'Should dates move to the new parser?',
            ask: 'ask-dates',
          }),
        ],
      })
      await serverRead({ s })
      first.release()
      await until({
        what: 'main to relay the outcome with the task’s new change',
        check: () => hydra.received.length === 2 && s.state().cards[HYDRA_CARD]?.sessionActivity === 'working',
      })
      assert.match(
        hydra.received[1]!,
        /Helper outcomes to relay/,
      )
      assert.ok(hydra.received[1]!.includes('Should dates move to the new parser?'))
      await until({
        what: 'the helper to release its lease',
        check: () => !existsSync(join(
          hydraDir({ hydraId: s.hydraId }),
          `helper-lease-${encodeURIComponent(work)}.json`,
        )),
      })
      await s.as({ agent: hydra }).run({
        args: [
          'task',
          'ask',
          'work',
          '--to',
          'owner',
          '--question',
          'Which parser should the worker use?',
          '--reason',
          'The helper escalated this choice.',
        ],
      })
      assert.equal(
        grants({ s }).length,
        1,
      )
    } finally {
      first.release()
      relay.release()
    }
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
        answered: 0,
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

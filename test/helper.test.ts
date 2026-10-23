import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { commands } from '../src/cli/commands.ts'
import { askAnswer } from '../src/core/asks.ts'
import { hydraConfig, hydraEvent, HYDRA_CARD } from '../src/core/hydra.ts'
import type { HydraEvent } from '../src/core/model.ts'
import { commandLease } from '../src/helper/commands.ts'
import { releaseTask, taskLease } from '../src/helper/leases.ts'
import { helperAgent, helperEvent, helperReason } from '../src/helper/route.ts'
import { createRoutineHelper, parseOutcomes } from '../src/helper/runner.ts'
import { outcomeLines, type HelperChange } from '../src/helper/state.ts'
import type { Provider } from '../src/server/provider.ts'
import { loadHydra, readEvents, withWriter } from '../src/store/hydra-store.ts'

let root = ''
let restore: NodeJS.ProcessEnv
const state = () => loadHydra({ hydraId: 'lab' }).state

beforeEach(() => {
  restore = { ...process.env }
  root = mkdtempSync(join(
    tmpdir(),
    'pnyx-helper-',
  ))
  process.env.PNYX_HOME = root
  commands.hydra([
    'create',
    'lab',
  ])
  commands.task([
    'create',
    '--key',
    'work',
    '--title',
    'Work',
    '--hydra',
    'lab',
  ])
  commands.task([
    'create',
    '--key',
    'other',
    '--title',
    'Other',
    '--hydra',
    'lab',
  ])
})

afterEach(() => {
  process.env = restore
  rmSync(
    root,
    {
      recursive: true,
      force: true,
    },
  )
})

function append({ change }: { change: HelperChange }) {
  withWriter({
    hydraId: 'lab',
    fn: ({ writer }) => {
      const decision = hydraEvent({
        state: writer.state,
        cardId: HYDRA_CARD,
        meta: {
          at: new Date().toISOString(),
          actor: 'pnyx',
        },
        change,
      })
      assert.ok('event' in decision)
      writer.append({ event: decision.event })
    },
  })
}

test(
  'fixed routing keeps results, PR actions, permissions, unknown tasks and owner decisions on main',
  () => {
    const s = state()
    const task = s.keys.work!
    const report = {
      type: 'hydra.message',
      actor: `worker:${task}`,
      cardId: HYDRA_CARD,
      data: {
        task,
        kind: 'progress',
      },
    } as HydraEvent
    assert.equal(
      helperEvent({
        state: s,
        event: report,
      }),
      task,
    )
    assert.equal(
      helperEvent({
        state: s,
        event: {
          ...report,
          data: {
            ...report.data,
            kind: undefined,
          },
        } as HydraEvent,
      }),
      undefined,
    )

    for (const kind of [
      'checks',
      'comments',
      'merged',
      'approved merge is green',
      'timed review',
      'permission',
      'slot free',
    ] as const) {
      assert.equal(
        helperReason({
          state: s,
          task,
          kind,
        }),
        false,
      )
    }

    for (const kind of [
      'quiet',
      'wait ended',
      'not confirmed',
      'turn ended',
      'asked',
    ] as const) {
      assert.equal(
        helperReason({
          state: s,
          task,
          kind,
        }),
        true,
      )
    }

    assert.equal(
      helperEvent({
        state: s,
        event: {
          ...report,
          data: {
            task: 'missing',
            kind: 'progress',
          },
        } as HydraEvent,
      }),
      undefined,
    )
    commands.task([
      'ask',
      task,
      '--to',
      'owner',
      '--question',
      'Expand the scope?',
      '--actor',
      'hydra',
      '--hydra',
      'lab',
    ])
    assert.equal(
      helperEvent({
        state: state(),
        event: report,
      }),
      undefined,
    )
    assert.equal(
      helperReason({
        state: state(),
        task,
        kind: 'quiet',
      }),
      false,
    )
    const ask = state().cards[task]!.asks![0]!
    assert.throws(
      () => askAnswer({
        card: state().cards[task]!,
        id: ask.id,
        actor: 'helper:test',
        text: 'yes',
      }),
      /cannot answer an owner/,
    )
  },
)

test(
  'helper settings select lighter defaults, accept each hosted harness and turn off explicitly',
  () => {
    assert.equal(
      helperAgent({ state: state() })?.model,
      'sonnet',
    )
    commands.hydra([
      'set',
      '--hydra',
      'lab',
      '--helper',
      'codex',
      '--helper-model',
      'test-light',
      '--helper-effort',
      'low',
    ])
    assert.deepEqual(
      helperAgent({ state: state() }),
      {
        harness: 'codex',
        model: 'test-light',
        effort: 'low',
      },
    )
    commands.hydra([
      'set',
      '--hydra',
      'lab',
      '--helper',
      'off',
    ])
    assert.equal(
      helperAgent({ state: state() }),
      undefined,
    )
    commands.hydra([
      'set',
      '--hydra',
      'lab',
      '--helper',
      'auto',
    ])
    assert.equal(
      helperAgent({ state: state() })?.harness,
      'claude',
    )
    assert.throws(() => commands.hydra([
      'set',
      '--hydra',
      'lab',
      '--helper',
      'unknown',
    ]))
  },
)

test(
  'leases exclude the competing actor, scope helper commands and release after their turn',
  () => {
    const task = state().keys.work!
    append({
      change: {
        type: 'hydra.helper-started',
        data: {
          id: 'batch',
          tasks: [task],
          prompt: 'wake',
          seqs: [],
        },
      },
    })
    const mainRelease = taskLease({
      hydraId: 'lab',
      task,
      actor: 'main',
    })
    assert.throws(
      () => taskLease({
        hydraId: 'lab',
        task,
        actor: 'helper:batch',
      }),
      /being handled/,
    )
    mainRelease()
    const helperRelease = taskLease({
      hydraId: 'lab',
      task,
      actor: 'helper:batch',
    })
    assert.throws(
      () => commands.task([
        'status',
        task,
        'working',
        '--actor',
        'hydra',
        '--hydra',
        'lab',
      ]),
      /being handled/,
    )
    commands.task([
      'status',
      'other',
      'working',
      '--actor',
      'hydra',
      '--hydra',
      'lab',
    ])
    const env = {
      PNYX_ACTOR: 'helper:batch',
      PNYX_HYDRA: 'lab',
    }

    for (const args of [
      [
        'merge',
        task,
      ],
      [
        'start',
        task,
      ],
      [
        'permission',
        task,
      ],
      [
        'continue',
        'other',
      ],
    ]) {
      assert.throws(() => commandLease({
        name: 'task',
        args,
        env,
      }))
    }

    assert.throws(() => commandLease({
      name: 'hydra',
      args: ['set'],
      env,
    }))
    assert.throws(() => commandLease({
      name: 'hydra',
      args: [
        'check',
        '--wait=1',
      ],
      env,
    }))
    assert.throws(() => commandLease({
      name: 'reply',
      args: [
        task,
        '--actor=hydra',
      ],
      env,
    }))
    const release = commandLease({
      name: 'reply',
      args: [
        task,
        '--text=Continue within scope',
      ],
      env,
    })
    release()
    assert.throws(() => taskLease({
      hydraId: 'lab',
      task,
      actor: 'main',
    }))
    helperRelease()
    taskLease({
      hydraId: 'lab',
      task,
      actor: 'main',
    })()
    append({
      change: {
        type: 'hydra.helper-finished',
        data: {
          batch: 'batch',
          outcomes: [],
          error: 'failed',
        },
      },
    })
    assert.throws(() => commandLease({
      name: 'reply',
      args: [task],
      env,
    }))
  },
)

function deferred() {
  let resolve = () => {}
  const promise = new Promise<void>(finish => {
    resolve = finish
  })

  return {
    promise,
    resolve,
  }
}

function helperLab() {
  let reply = ''
  let fail = false
  let held: Promise<void> | undefined
  let expire = () => {}
  let opened = deferred()
  let idle = deferred()
  const inputs: string[] = []
  const opens: Parameters<Provider['open']>[0][] = []
  const handbacks: {
    id: string
    text: string
  }[] = []
  let ownerWakes = 0
  const provider: Provider = {
    models: async () => [],
    defaults: async ({ models }) => models,
    // eslint-disable-next-line pnyx/object-params -- The provider owns this callback signature.
    open: async options => {
      opens.push(options)
      opened.resolve()

      return {
        id: 'helper-session',
        set: async () => {},
        interrupt: async () => {},
        close() {},
        async *run({ input }) {
          for await (const text of input) {
            inputs.push(text)
            await held

            if (fail) {
              throw new Error('provider failed')
            }

            yield {
              type: 'text',
              id: 'final',
              text: reply,
            }
            yield 'finished'
          }
        },
      }
    },
  }
  const helper = createRoutineHelper({
    hydraId: 'lab',
    provider: () => provider,
    environment: ({ actor }) => ({
      PNYX_HOME: root,
      PNYX_HYDRA: 'lab',
      PNYX_ACTOR: actor,
    }),
    context: () => 'Hydra rules',
    changed: () => {
      if (!helper.busy()) {
        idle.resolve()
      }
    },
    handback: ({
      id,
      text,
    }) => handbacks.push({
      id,
      text,
    }),
    outcomesReady: () => ownerWakes++,
    deadline: ({ expire: callback }) => {
      expire = callback

      return () => {}
    },
  })

  return {
    helper,
    inputs,
    opens,
    handbacks,
    ownerWakes: () => ownerWakes,
    expire: () => expire(),
    async run({
      text,
      error = false,
      wait,
    }: {
      text: string
      error?: boolean
      wait?: Promise<void>
    }) {
      reply = text
      fail = error
      held = wait
      idle = deferred()
      opened = deferred()
      helper.offer({
        tasks: [state().keys.work!],
        prompt: 'Worker turn ended',
        seqs: [state().seq],
      })
      await opened.promise

      return { finished: idle.promise }
    },
  }
}

test(
  'bounded turns record quiet outcomes, reuse their own session and relay owner outcomes once through main',
  async () => {
    const lab = helperLab()
    const task = state().keys.work!
    const first = await lab.run({
      text: JSON.stringify({
        outcomes: [
          {
            task,
            audience: 'routine',
            summary: 'Worker resumed.',
          },
        ],
      }),
    })
    await first.finished
    assert.equal(
      lab.ownerWakes(),
      0,
    )
    assert.deepEqual(
      outcomeLines({ state: state() }),
      [],
    )
    assert.equal(
      lab.opens[0]!.settings.model,
      'sonnet',
    )
    assert.match(
      lab.opens[0]!.env.PNYX_ACTOR!,
      /^helper:/,
    )
    const second = await lab.run({
      text: JSON.stringify({
        outcomes: [
          {
            task,
            audience: 'owner',
            summary: 'Findings ready: https://example.test/report',
          },
        ],
      }),
    })
    await second.finished
    assert.equal(
      lab.opens[1]!.agent?.sessionId,
      'helper-session',
    )
    assert.equal(
      lab.ownerWakes(),
      1,
    )
    assert.deepEqual(
      outcomeLines({ state: state() }),
      [`- ${task}: Findings ready: https://example.test/report`],
    )
    append({
      change: {
        type: 'hydra.helper-acknowledged',
        data: {
          batches: [],
          through: state().seq,
        },
      },
    })
    assert.deepEqual(
      outcomeLines({ state: state() }),
      [],
    )
    assert.equal(
      state().helper!.outcomes.length,
      2,
    )
    lab.helper.close()
  },
)

test(
  'failed, unreported and timed-out turns hand back exactly once, release locks and never retry',
  async () => {
    for (const failure of [
      'provider',
      'missing report',
      'timeout',
    ]) {
      const lab = helperLab()
      const held = deferred()
      const turn = await lab.run({
        text: 'NO_REPLY',
        error: failure === 'provider',
        wait: failure === 'timeout' ? held.promise : undefined,
      })

      if (failure === 'timeout') {
        lab.expire()
      }

      await turn.finished
      held.resolve()
      assert.equal(
        lab.handbacks.length,
        1,
      )
      assert.match(
        lab.handbacks[0]!.text,
        /Worker turn ended/,
      )
      assert.equal(
        lab.opens.length,
        1,
      )
      taskLease({
        hydraId: 'lab',
        task: state().keys.work!,
        actor: 'main',
      })()
      lab.helper.close()
    }
  },
)

test(
  'restart hands an unfinished durable batch to main, preserving its prompt and original event scope',
  () => {
    const task = state().keys.work!
    append({
      change: {
        type: 'hydra.helper-started',
        data: {
          id: 'cut',
          tasks: [task],
          prompt: 'Original wake with reason',
          seqs: [2],
        },
      },
    })
    taskLease({
      hydraId: 'lab',
      task,
      actor: 'helper:cut',
    })
    const lab = helperLab()
    lab.helper.recover()
    assert.equal(
      lab.handbacks.length,
      1,
    )
    assert.equal(
      lab.handbacks[0]!.id,
      'helper-handback:cut',
    )
    assert.match(
      lab.handbacks[0]!.text,
      /Original wake with reason/,
    )
    assert.ok(state().helper!.handled.includes(2))
    taskLease({
      hydraId: 'lab',
      task,
      actor: 'main',
    })()
    releaseTask({
      hydraId: 'lab',
      task,
      actor: 'helper:cut',
    })
    assert.ok(readEvents({ hydraId: 'lab' }).some(event => event.type === 'hydra.helper-finished'))
  },
)

test(
  'outcome receipts reject incomplete scope, duplicates and multiline notes',
  () => {
    for (const outcomes of [
      [],
      [
        {
          task: 'other',
          audience: 'routine',
          summary: 'ok',
        },
      ],
      [
        {
          task: 'work',
          audience: 'owner',
          summary: 'two\nlines',
        },
      ],
      [
        {
          task: 'work',
          audience: 'routine',
          summary: 'ok',
        },
        {
          task: 'work',
          audience: 'routine',
          summary: 'again',
        },
      ],
    ]) {
      assert.throws(() => parseOutcomes({
        text: JSON.stringify({ outcomes }),
        tasks: ['work'],
      }))
    }

    assert.equal(
      hydraConfig({ state: state() }).helper,
      undefined,
    )
  },
)

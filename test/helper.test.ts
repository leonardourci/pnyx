import { steeringNotice } from '../src/task-inbox/notice.ts'
import { once } from 'node:events'
import { fakeDispatch } from './dispatch-fixture.ts'
import { fakeCodex } from './codex-fixture.ts'
import { configPath, writeConfig } from '../src/dispatch/config.ts'
import { createHost, hostRequest } from '../src/server/host.ts'
import { hydraSdk } from './hydra-host-fixture.ts'
import { helperTask } from '../src/helper/route.ts'
import { wakeHandled } from '../src/helper/state.ts'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
import { createRoutineHelper, HELPER_INSTRUCTIONS, outcomeSchema, parseOutcomes } from '../src/helper/runner.ts'
import { helperLeases, outcomeLines, type HelperChange } from '../src/helper/state.ts'
import { hydraDigest } from '../src/core/digest.ts'
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
  process.env.CLAUDE_CONFIG_DIR = join(
    root,
    'claude',
  )
  process.env.CODEX_HOME = join(
    root,
    'codex',
  )
  process.env.PNYX_SEMANTIC = 'off'
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
    commandLease({
      name: 'task',
      args: [
        '--hydra',
        'lab',
        'show',
        task,
      ],
      env,
    })()
    assert.throws(
      () => commands.task([
        'status',
        '--hydra',
        'lab',
        task,
        'working',
        '--actor',
        'cli',
      ]),
      /being handled|leased/,
    )
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
  const harnesses: string[] = []
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
    provider: ({ harness }) => {
      harnesses.push(harness)

      return provider
    },
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
    harnesses,
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
        once: ['wait:expired'],
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
      [`- [@Work](pnyx-task:${task}): Findings ready: https://example.test/report`],
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

test(
  'held tasks stay main-owned even before a go question is asked',
  () => {
    const task = state().keys.work!
    commands.task([
      'hold',
      task,
      '--reason',
      'Discuss first',
      '--hydra',
      'lab',
    ])
    assert.equal(
      helperTask({
        state: state(),
        task,
      }),
      false,
    )
    assert.equal(
      helperReason({
        state: state(),
        task,
        kind: 'quiet',
      }),
      false,
    )
    append({
      change: {
        type: 'hydra.helper-started',
        data: {
          id: 'held',
          tasks: [task],
          prompt: 'wake',
          seqs: [],
        },
      },
    })
    assert.throws(() => commandLease({
      name: 'reply',
      args: [task],
      env: {
        PNYX_HYDRA: 'lab',
        PNYX_ACTOR: 'helper:held',
      },
    }))
  },
)

test(
  'overlapping main host requests retain every lease until their own action settles',
  async () => {
    const task = state().keys.work!
    append({
      change: {
        type: 'hydra.helper-started',
        data: {
          id: 'next',
          tasks: [task],
          prompt: 'wake',
          seqs: [],
        },
      },
    })
    const host = createHost({
      hydraId: 'lab',
      changed: () => {},
    })
    const first = deferred(), second = deferred(), entered = deferred()
    let calls = 0

    host.set = async () => {
      calls++
      const turn = calls

      if (turn === 2) {
        entered.resolve()
      }

      await (turn === 1 ? first.promise : second.promise)
    }

    const body = {
      action: 'set',
      card: task,
      setting: 'model',
      value: 'sonnet',
      actor: 'hydra',
    }
    const requestA = hostRequest({
      host,
      body,
    })
    const requestB = hostRequest({
      host,
      body,
    })

    try {
      await entered.promise
      first.resolve()
      await requestA
      assert.throws(
        () => taskLease({
          hydraId: 'lab',
          task,
          actor: 'helper:next',
        }),
        /being handled/,
      )
      second.resolve()
      await requestB
      taskLease({
        hydraId: 'lab',
        task,
        actor: 'helper:next',
      })()
    } finally {
      first.resolve(); second.resolve(); host.close()
    }
  },
)

test(
  'host requests enforce helper grants and reserved actions at the server boundary',
  async () => {
    const task = state().keys.work!
    append({
      change: {
        type: 'hydra.helper-started',
        data: {
          id: 'host',
          tasks: [task],
          prompt: 'wake',
          seqs: [],
        },
      },
    })
    const release = taskLease({
      hydraId: 'lab',
      task,
      actor: 'helper:host',
    })
    const host = createHost({
      hydraId: 'lab',
      changed: () => {},
    })
    const sent: string[] = []

    host.send = ({ text }) => {
      sent.push(text)
    }

    const actor = 'helper:host'

    try {
      for (const action of [
        'start',
        'set',
        'permission',
        'stop',
        'hydra',
      ]) {
        await assert.rejects(
          hostRequest({
            host,
            body: {
              action,
              actor,
              task,
            },
          }),
          /main Hydra/,
        )
      }

      await assert.rejects(
        hostRequest({
          host,
          body: {
            action: 'send',
            actor,
            card: state().keys.other,
            text: 'out of scope',
          },
        }),
        /main Hydra/,
      )
      await hostRequest({
        host,
        body: {
          action: 'send',
          actor,
          card: task,
          text: 'Continue within scope',
        },
      })
      assert.deepEqual(
        sent,
        ['Continue within scope'],
      )
      assert.throws(() => taskLease({
        hydraId: 'lab',
        task,
        actor: 'main',
      }))
      release()
      commands.task([
        'hold',
        task,
        '--reason',
        'Owner discussion',
        '--hydra',
        'lab',
      ])
      await assert.rejects(
        hostRequest({
          host,
          body: {
            action: 'send',
            actor,
            card: task,
            text: 'must refuse',
          },
        }),
        /main Hydra/,
      )
    } finally {
      release(); host.close()
    }
  },
)

test(
  'Codex helper settings select its provider and a deadline hands back without another attempt',
  async () => {
    commands.hydra([
      'set',
      '--hydra',
      'lab',
      '--helper',
      'codex',
      '--helper-model',
      'light-codex',
      '--helper-effort',
      'low',
    ])
    const lab = helperLab()
    const hold = deferred()
    const turn = await lab.run({
      text: 'NO_REPLY',
      wait: hold.promise,
    })
    assert.deepEqual(
      lab.harnesses,
      ['codex'],
    )
    assert.deepEqual(
      lab.opens[0]!.settings,
      {
        model: 'light-codex',
        effort: 'low',
      },
    )
    assert.match(
      lab.opens[0]!.env.PNYX_ACTOR!,
      /^helper:/,
    )
    lab.expire()
    await turn.finished
    hold.resolve()
    assert.equal(
      lab.handbacks.length,
      1,
    )
    assert.equal(
      lab.opens.length,
      1,
    )
  },
)

test(
  'offline progress is recovered into a helper turn without waking main',
  async () => {
    const task = state().keys.work!
    const sdk = hydraSdk()
    sdk.control.stream = true
    sdk.control.reply = JSON.stringify({
      outcomes: [
        {
          task,
          audience: 'routine',
          summary: 'Progress received.',
        },
      ],
    })
    const done = deferred()
    withWriter({
      hydraId: 'lab',
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
              task,
              action: 'send',
              hydra: 'hydra',
              kind: 'progress',
              text: 'Offline progress',
            },
          },
        })
        assert.ok('event' in decision)
        writer.append({ event: decision.event })
      },
    })
    const host = createHost({
      hydraId: 'lab',
      query: sdk.query,
      wakeDelay: 0,
      changed: () => {
        if (state().helper?.outcomes.length) {
          done.resolve()
        }
      },
    })

    try {
      await host.recover()
      await done.promise
      assert.equal(
        sdk.calls.length,
        1,
      )
      assert.match(
        sdk.calls[0]!.options.env!.PNYX_ACTOR!,
        /^helper:/,
      )
      assert.ok(sdk.calls[0]!.raw[0]!.includes('Offline progress'))
      assert.equal(
        wakeHandled({
          state: state(),
          id: 'wait:expired',
        }),
        false,
      )
    } finally {
      host.close()
    }

    const recovered = createHost({
      hydraId: 'lab',
      query: sdk.query,
      wakeDelay: 0,
      changed: () => {},
    })
    await recovered.recover()
    assert.deepEqual(
      recovered.queue().waiting,
      [],
    )
    assert.equal(
      sdk.calls.length,
      1,
    )
    recovered.close()
  },
)

test(
  'one-time wait identities survive helper completion and replay',
  async () => {
    const lab = helperLab()
    const task = state().keys.work!
    const turn = await lab.run({
      text: JSON.stringify({
        outcomes: [
          {
            task,
            audience: 'routine',
            summary: 'Wait handled.',
          },
        ],
      }),
    })
    await turn.finished
    assert.equal(
      wakeHandled({
        state: state(),
        id: 'wait:expired',
      }),
      true,
    )
  },
)

test(
  'a helper-handled ended wait is not offered again after host restart',
  async t => {
    const task = state().keys.work!
    const sdk = hydraSdk()
    sdk.control.stream = true
    sdk.control.reply = 'NO_REPLY'
    const mainDone = deferred(), helperDone = deferred()
    t.mock.timers.enable({
      apis: [
        'setTimeout',
        'setInterval',
        'Date',
      ],
      now: Date.now(),
    })
    const host = createHost({
      hydraId: 'lab',
      query: sdk.query,
      stallDelay: 4000,
      changed: () => {
        if (state().cards[HYDRA_CARD]?.sessionActivity === 'finished') {
          mainDone.resolve()
        }

        if (state().helper?.outcomes.length) {
          helperDone.resolve()
        }
      },
    })
    await host.hydra({
      text: 'Begin',
      actor: 'web',
      id: 'begin',
    })
    await mainDone.promise
    commands.task([
      'status',
      task,
      'paused',
      '--until',
      new Date(Date.now() + 500).toISOString(),
      '--actor',
      `worker:${task}`,
      '--hydra',
      'lab',
    ])
    sdk.control.reply = JSON.stringify({
      outcomes: [
        {
          task,
          audience: 'routine',
          summary: 'Wait checked.',
        },
      ],
    })
    t.mock.timers.tick(1000)
    await helperDone.promise
    const batches = readEvents({ hydraId: 'lab' }).filter(event => event.type === 'hydra.helper-started')
    assert.equal(
      batches.length,
      1,
    )
    host.close()
    const resumed = createHost({
      hydraId: 'lab',
      query: sdk.query,
      stallDelay: 4000,
      changed: () => {},
    })

    try {
      await resumed.recover()
      t.mock.timers.tick(1000)
      assert.equal(
        readEvents({ hydraId: 'lab' }).filter(event => event.type === 'hydra.helper-started').length,
        1,
      )
    } finally {
      resumed.close(); t.mock.timers.reset()
    }
  },
)

test(
  'an implicit Codex main selects the Codex helper through the real hosted adapter',
  async () => {
    fakeDispatch({ root })
    writeConfig({
      path: configPath({
        hydraId: 'lab',
        shared: true,
      }),
      value: {
        default: [
          {
            harness: 'codex',
            model: 'main-codex',
          },
        ],
        rules: {
          hydra: {
            when: 'Run the main Hydra',
            candidates: [
              {
                harness: 'codex',
                model: 'main-codex',
              },
            ],
          },
        },
      },
    })
    const task = state().keys.work!
    withWriter({
      hydraId: 'lab',
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
              task,
              action: 'send',
              hydra: 'hydra',
              kind: 'progress',
              text: 'Offline Codex progress',
            },
          },
        })
        assert.ok('event' in decision)
        writer.append({ event: decision.event })
      },
    })
    const codex = fakeCodex({ root })
    const done = deferred()
    const host = createHost({
      hydraId: 'lab',
      spawnCodex: codex.spawnCodex,
      wakeDelay: 0,
      query: () => {
        throw new Error('Claude should not run for an implicit Codex main')
      },
      changed: () => {
        if (state().helper && Object.values(state().helper!.runs).some(batch => batch.error)) {
          done.resolve()
        }
      },
    })

    try {
      await host.recover()
      await done.promise
      assert.equal(
        codex.environments.length,
        1,
      )
      assert.match(
        codex.environments[0]!.PNYX_ACTOR!,
        /^helper:/,
      )
      assert.ok(codex.messages().some(message => message.method === 'thread/start' && message.params?.model === 'gpt-6-luna'))
    } finally {
      host.close()
      await Promise.all(codex.children.map(child => child.exitCode === null ? once(
        child,
        'exit',
      ) : Promise.resolve()))
    }
  },
)

test(
  'a granted helper nudge reaches a real hosted worker through the server request path',
  async () => {
    const task = state().keys.work!
    const sdk = hydraSdk()
    let done = deferred()
    const host = createHost({
      hydraId: 'lab',
      query: sdk.query,
      changed: () => {
        if (state().cards[task]?.sessionActivity === 'finished') {
          done.resolve()
        }
      },
    })
    let release = () => {}

    try {
      await host.start({
        task,
        prompt: 'Start this work',
        folder: root,
        settings: { provider: 'claude-code' },
        id: 'start-worker',
        actor: 'cli',
      })
      await done.promise
      append({
        change: {
          type: 'hydra.helper-started',
          data: {
            id: 'nudge',
            tasks: [task],
            prompt: 'Worker needs a nudge',
            seqs: [],
          },
        },
      })
      release = taskLease({
        hydraId: 'lab',
        task,
        actor: 'helper:nudge',
      })
      done = deferred()
      await hostRequest({
        host,
        body: {
          action: 'send',
          card: task,
          actor: 'helper:nudge',
          text: 'Continue within the accepted scope.',
        },
      })
      await done.promise
      const instruction = state().cards[task]!.steering!.at(-1)!
      assert.equal(
        instruction.text,
        'Continue within the accepted scope.',
      )
      assert.ok(sdk.calls[0]!.messages.includes(steeringNotice({
        task,
        hydraId: 'lab',
        ids: [instruction.id],
      })))
    } finally {
      release(); host.close()
    }
  },
)

test(
  'recorded long summaries and prose still fail validation with explicit output limits',
  () => {
    const fixtures = JSON.parse(readFileSync(
      new URL(
        './fixtures/helper/malformed.json',
        import.meta.url,
      ),
      'utf8',
    )) as {
      name: string
      tasks: string[]
      text: string
    }[]

    for (const fixture of fixtures) {
      assert.throws(
        () => parseOutcomes({
          text: fixture.text,
          tasks: fixture.tasks,
        }),
        fixture.name,
      )
    }

    assert.equal(
      JSON.parse(fixtures[0]!.text).outcomes[0].summary.length,
      693,
    )
    assert.equal(
      JSON.parse(fixtures[1]!.text).outcomes[1].summary.length,
      667,
    )
    assert.match(
      HELPER_INSTRUCTIONS,
      /at most 600 characters/,
    )
    assert.match(
      HELPER_INSTRUCTIONS,
      /never pass --actor/,
    )
    assert.match(
      HELPER_INSTRUCTIONS,
      /Copy supplied links exactly; omit links that were not supplied/,
    )
    const schema = outcomeSchema({ tasks: ['work'] })
    assert.ok(JSON.stringify(schema).includes('at most 600 characters'))
    assert.ok(!JSON.stringify(schema).includes('maxLength'))
    assert.ok(!JSON.stringify(schema).includes('maxItems'))
    assert.deepEqual(
      parseOutcomes({
        text: JSON.stringify({
          outcomes: [
            {
              task: 'work',
              audience: 'owner',
              summary: 'a'.repeat(600),
            },
          ],
        }),
        tasks: ['work'],
      })[0]!.summary.length,
      600,
    )
  },
)

test(
  'active helper leases carry event start times in the digest and disappear on handback',
  () => {
    const task = state().keys.work!
    append({
      change: {
        type: 'hydra.helper-started',
        data: {
          id: 'held',
          tasks: [task],
          seqs: [],
          prompt: 'Progress',
        },
      },
    })
    const grant = readEvents({ hydraId: 'lab' }).at(-1)!
    const digest = hydraDigest({
      hydraId: 'lab',
      state: state(),
      owner: {},
    })
    assert.ok(digest.includes(`held by helper:held, started ${grant.at}`))
    assert.ok(digest.includes(`[@Work](pnyx-task:${task})`))
    append({
      change: {
        type: 'hydra.helper-finished',
        data: {
          batch: 'held',
          outcomes: [],
          error: 'handed back',
        },
      },
    })
    assert.deepEqual(
      helperLeases({ state: state() }),
      ['Active helper leases: none'],
    )
  },
)

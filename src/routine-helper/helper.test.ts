import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { commands } from '#app/cli.ts'
import { askAnswer } from '#tasks/questions.ts'
import { hydraConfig } from '#hydra/config.ts'
import type { HydraEvent, HydraState } from '#app/model.ts'
import type { PermissionRequest } from '#workers/model.ts'
import { taskLease } from './leases.ts'
import { helperBatch, helperEvent, helperGrant, helperReason } from './route.ts'
import { createRoutineHelper, HELPER_INSTRUCTIONS, outcomeSchema, parseOutcomes } from './runner.ts'
import { until } from '#test-harness/harness.ts'
import type { Provider } from '#workers/provider.ts'
import { loadHydra } from '#app/store.ts'
import { readEvents } from '#app/event-log.ts'

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

const granted = ({
  state,
  tasks,
}: {
  state: HydraState
  tasks: string[]
}): HydraState => ({
  ...state,
  helper: {
    runs: {
      batch: {
        id: 'batch',
        tasks,
        prompt: '',
        seqs: [],
      },
    },
    outcomes: [],
    handled: [],
    wakes: [],
    delivered: 0,
  },
})

test(
  'fixed routing keeps results, PR actions, progress, unknown tasks and owner answers off the helper',
  () => {
    const s = state()
    const task = s.keys.work!
    const other = s.keys.other!
    const report = {
      type: 'hydra.message',
      actor: `worker:${task}`,
      cardId: task,
      data: {
        action: 'send',
        hydra: 'hydra',
        task,
        ask: 'ask-1',
        text: 'Which parser?',
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
            ask: undefined,
            kind: 'progress',
          },
        } as HydraEvent,
      }),
      undefined,
    )
    assert.equal(
      helperEvent({
        state: s,
        event: {
          ...report,
          data: {
            ...report.data,
            ask: undefined,
          },
        } as HydraEvent,
      }),
      undefined,
    )
    assert.equal(
      helperEvent({
        state: s,
        event: {
          ...report,
          data: {
            ...report.data,
            task: 'missing',
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
      'declared',
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
      helperGrant({
        state: granted({
          state: s,
          tasks: [other],
        }),
        task: other,
        actor: 'helper:batch',
        action: 'answer',
      }),
      true,
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
    // Waiting on the owner leaves the helper only the worker's nudges and plain permission prompts.
    assert.equal(
      helperReason({
        state: state(),
        task,
        kind: 'quiet',
      }),
      true,
    )
    assert.equal(
      helperReason({
        state: state(),
        task,
        kind: 'asked',
      }),
      false,
    )

    const prompted = ({ request }: { request: Partial<PermissionRequest> }) => {
      const next = structuredClone(state())
      next.cards[task]!.permissions = [
        {
          id: 'request-1',
          tool: 'Bash',
          status: 'pending',
          ...request,
        } as PermissionRequest,
      ]

      return next
    }

    assert.equal(
      helperReason({
        state: prompted({ request: {} }),
        task,
        kind: 'permission',
      }),
      true,
    )
    assert.equal(
      helperReason({
        state: prompted({
          request: {
            tool: 'AskUserQuestion',
            questions: [{ question: 'Which parser?' }] as PermissionRequest['questions'],
          },
        }),
        task,
        kind: 'permission',
      }),
      false,
    )
    const owned = granted({
      state: state(),
      tasks: [task],
    })
    assert.equal(
      helperGrant({
        state: owned,
        task,
        actor: 'helper:batch',
        action: 'reply',
      }),
      true,
    )
    assert.equal(
      helperGrant({
        state: owned,
        task,
        actor: 'helper:batch',
        action: 'continue',
      }),
      true,
    )
    assert.equal(
      helperGrant({
        state: owned,
        task,
        actor: 'helper:batch',
        action: 'permission',
      }),
      true,
    )
    assert.equal(
      helperGrant({
        state: owned,
        task,
        actor: 'helper:batch',
        action: 'answer',
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

function helperLab({
  failClose = false,
  cost,
}: {
  failClose?: boolean
  cost?: number
} = {}) {
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
        close() {
          if (failClose) {
            throw new Error('session cleanup failed')
          }
        },
        async *run({ input }) {
          for await (const text of input) {
            inputs.push(text)
            await held

            if (cost !== undefined) {
              yield {
                type: 'usage',
                cost,
              } as const
            }

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
      tasks = [state().keys.work!],
    }: {
      text: string
      error?: boolean
      wait?: Promise<void>
      tasks?: string[]
    }) {
      reply = text
      fail = error
      held = wait
      idle = deferred()
      opened = deferred()
      helper.offer({
        tasks,
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
  'a failed lease release does not skip the other lease and recovery finishes cleanup without duplicating the outcome',
  async t => {
    const lab = helperLab()
    const tasks = [
      state().keys.work!,
      state().keys.other!,
    ]
    const original = fs.openSync
    let failed = false
    t.mock.method(
      console,
      'error',
      () => {},
    )
    t.mock.method(
      fs,
      'openSync',
      // eslint-disable-next-line pnyx/object-params -- Node owns fs.openSync's signature.
      (...args: Parameters<typeof fs.openSync>) => {
        if (!failed && String(args[0]).endsWith('/writer.lock') && new Error().stack?.includes('at releaseTask ')) {
          failed = true
          throw Object.assign(
            new Error('lease cleanup failed'),
            { code: 'EIO' },
          )
        }

        return original(...args)
      },
    )
    syncBuiltinESMExports()
    t.after(() => {
      lab.helper.close()
      t.mock.restoreAll()
      syncBuiltinESMExports()
    })
    const turn = await lab.run({
      text: 'invalid outcome',
      tasks,
    })
    await turn.finished
    assert.ok(failed)
    assert.equal(
      lab.helper.busy(),
      false,
    )
    assert.equal(
      lab.handbacks.length,
      1,
    )
    const lease = ({ task }: { task: string }) => join(
      root,
      `hydras/lab/helper-lease-${encodeURIComponent(task)}.json`,
    )
    assert.ok(fs.existsSync(lease({ task: tasks[0]! })))
    assert.equal(
      fs.existsSync(lease({ task: tasks[1]! })),
      false,
    )
    await lab.helper.recover()
    assert.equal(
      fs.existsSync(lease({ task: tasks[0]! })),
      false,
    )
    assert.equal(
      readEvents({ hydraId: 'lab' }).filter(event => event.type === 'hydra.helper-finished').length,
      1,
    )
  },
)

test(
  'a failed session cleanup still releases every task lease and resets busy',
  async t => {
    const lab = helperLab({
      failClose: true,
      cost: 0.25,
    })
    t.mock.method(
      console,
      'error',
      () => {},
    )
    t.after(() => lab.helper.close())
    const turn = await lab.run({ text: 'invalid outcome' })
    await turn.finished
    assert.equal(
      lab.helper.busy(),
      false,
    )
    taskLease({
      hydraId: 'lab',
      task: state().keys.work!,
      actor: 'main',
    })()
    assert.equal(
      lab.handbacks.length,
      1,
    )
    assert.deepEqual(
      state().helper?.usage,
      {
        cost: 0.25,
        batches: 1,
        measuredBatches: 1,
      },
    )
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
  'recorded long summaries and prose still fail validation with explicit output limits',
  () => {
    const fixtures = JSON.parse(readFileSync(
      new URL(
        './fixtures/malformed.json',
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
  'a burst becomes a capped batch: the oldest worker questions first, then the oldest other tasks, within the input budget',
  () => {
    const items = [
      {
        task: 'quiet-old',
        seq: 1,
        question: false,
      },
      {
        task: 'asked-new',
        seq: 9,
        question: true,
      },
      {
        task: 'quiet-new',
        seq: 5,
        question: false,
      },
      {
        task: 'asked-old',
        seq: 7,
        question: true,
      },
      {
        task: 'quiet-old',
        seq: 2,
        question: false,
      },
    ]
    assert.deepEqual(
      helperBatch({
        items,
        prompt: ({ tasks }) => tasks.join(','),
      })?.tasks,
      [
        'asked-old',
        'asked-new',
        'quiet-old',
      ],
    )
    // A task's later question outranks its own earlier quiet item.
    assert.deepEqual(
      helperBatch({
        items: [
          ...items,
          {
            task: 'quiet-old',
            seq: 8,
            question: true,
          },
        ],
        prompt: ({ tasks }) => tasks.join(','),
      })?.tasks,
      [
        'asked-old',
        'quiet-old',
        'asked-new',
      ],
    )
    assert.deepEqual(
      helperBatch({
        items,
        prompt: ({ tasks }) => 'x'.repeat(tasks.length * 24_000),
      })?.tasks,
      ['asked-old'],
    )
    assert.deepEqual(
      helperBatch({
        items,
        prompt: () => 'x'.repeat(24_001),
      })?.tasks,
      ['asked-old'],
    )
    assert.equal(
      helperBatch({
        items: [],
        prompt: () => '',
      }),
      undefined,
    )
  },
)

test(
  'the helper starts a fresh conversation after 20 turns and carries its last outcomes into each prompt',
  async t => {
    const lab = helperLab()
    t.after(() => lab.helper.close())
    const task = state().keys.work!

    for (let turn = 0; turn <= 20; turn++) {
      const run = await lab.run({
        text: JSON.stringify({
          outcomes: [
            {
              task,
              audience: 'routine',
              summary: `Nudged ${turn}.`,
            },
          ],
        }),
      })
      await run.finished
    }

    assert.equal(
      lab.opens[0]!.agent,
      undefined,
    )
    assert.ok(lab.opens[1]!.agent)
    assert.ok(lab.opens[19]!.agent)
    assert.equal(
      lab.opens[20]!.agent,
      undefined,
    )
    assert.ok(lab.inputs[20]!.includes(`Your earlier outcomes on these tasks:
- ${task} (routine): Nudged 17.
- ${task} (routine): Nudged 18.
- ${task} (routine): Nudged 19.
`))
  },
)

test(
  'a task lease main holds for a moment delays the helper batch instead of failing it',
  async t => {
    const lab = helperLab()
    const errors = t.mock.method(
      console,
      'error',
      () => {},
    )
    t.after(() => lab.helper.close())
    const task = state().keys.work!
    const release = taskLease({
      hydraId: 'lab',
      task,
      actor: 'main',
    })
    const run = lab.run({
      text: JSON.stringify({
        outcomes: [
          {
            task,
            audience: 'routine',
            summary: 'Nudged.',
          },
        ],
      }),
    })
    await until({
      what: 'the helper to wait on main’s lease',
      check: () => errors.mock.calls.some(call => (call.arguments[1] as { code?: string })?.code === 'TASK_LEASED'),
    })
    release()
    await (await run).finished
    assert.equal(
      lab.handbacks.length,
      0,
    )
    assert.deepEqual(
      state().helper?.outcomes.map(outcome => outcome.summary),
      ['Nudged.'],
    )
  },
)

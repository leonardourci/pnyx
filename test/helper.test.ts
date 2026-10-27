import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { commands } from '../src/cli/commands.ts'
import { askAnswer } from '../src/core/asks.ts'
import { hydraConfig, HYDRA_CARD } from '../src/core/hydra.ts'
import type { HydraEvent } from '../src/core/model.ts'
import { taskLease } from '../src/helper/leases.ts'
import { helperEvent, helperReason } from '../src/helper/route.ts'
import { createRoutineHelper, HELPER_INSTRUCTIONS, outcomeSchema, parseOutcomes } from '../src/helper/runner.ts'
import type { Provider } from '../src/server/provider.ts'
import { loadHydra, readEvents } from '../src/store/hydra-store.ts'

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

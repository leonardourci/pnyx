import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { hydraCheck } from '../src/cli/workers.ts'
import { commands } from '../src/cli/commands.ts'
import type { PaseoClient } from '@getpaseo/client'
import { fakeDispatch } from '../src/test-harness/dispatch-fixture.ts'
import { startTask, freeTask } from '../src/cli/start.ts'
import { hydraEvent } from '../src/core/hydra.ts'
import { emptyHydra, replay } from '../src/core/reducer.ts'
import { readyBacklog } from '../src/core/wake-reasons.ts'
import { decisionsBlock } from '../src/core/decisions.ts'
import { loadHydra, readEvents, withWriter } from '../src/store/hydra-store.ts'
import { createHost } from '../src/server/host.ts'
import { cardState } from '../web/src/hydra/view.ts'

function lab({ t }: { t: TestContext }) {
  const home = mkdtempSync(join(
    tmpdir(),
    'pnyx-hold-',
  ))
  const previousPath = process.env.PATH
  const previousHome = process.env.PNYX_HOME
  const previousActor = process.env.PNYX_ACTOR
  process.env.PNYX_HOME = home
  delete process.env.PNYX_ACTOR
  t.mock.timers.enable({
    apis: ['Date'],
    now: Date.parse('2026-10-20T12:00:00Z'),
  })
  t.after(() => {
    process.env.PATH = previousPath

    if (previousHome === undefined) {
      delete process.env.PNYX_HOME
    } else {
      process.env.PNYX_HOME = previousHome
    }

    if (previousActor === undefined) {
      delete process.env.PNYX_ACTOR
    } else {
      process.env.PNYX_ACTOR = previousActor
    }

    rmSync(
      home,
      {
        recursive: true,
        force: true,
      },
    )
  })
  commands.hydra([
    'create',
    'lab',
  ])
  const state = () => loadHydra({ hydraId: 'lab' }).state
  const task = () => state().cards[state().keys.idea!]!
  const run = ({ args }: { args: string[] }) => commands.task([
    ...args,
    '--hydra',
    'lab',
    '--reason',
    'Owner discussion',
  ])
  const create = ({ args = [] }: { args?: string[] } = {}) => run({
    args: [
      'create',
      '--key',
      'idea',
      '--title',
      'Discuss exports',
      ...args,
    ],
  })
  const message = ({
    id,
    actor = 'web',
    action = 'send',
    text = 'Go ahead',
  }: {
    id: string
    actor?: string
    action?: 'send' | 'worker'
    text?: string
  }) => withWriter({
    hydraId: 'lab',
    fn: ({ writer }) => {
      const decision = hydraEvent({
        state: writer.state,
        meta: {
          id,
          actor,
          at: new Date().toISOString(),
        },
        cardId: '$hydra',
        change: {
          type: 'hydra.message',
          data: {
            action,
            text,
            hydra: 'lab',
          },
        },
      })
      assert.ok('event' in decision)
      writer.append({ event: decision.event })
    },
  })
  const ask = () => run({
    args: [
      'ask',
      'idea',
      '--to',
      'owner',
      '--kind',
      'go',
      '--question',
      'Build the agreed export?',
      '--actor',
      'hydra',
    ],
  })
  const answer = ({ args }: { args: string[] }) => run({
    args: [
      'answer',
      'idea',
      task().asks!.at(-1)!.id,
      ...args,
    ],
  })

  const column = ({ role }: { role: string }) =>
    state().config!.columns.find(c => c.role === role)!.id

  return {
    home,
    state,
    task,
    run,
    create,
    message,
    ask,
    answer,
    column,
  }
}

test(
  'held cards stay Talking in Backlog and every work command refuses without side effects',
  async t => {
    const s = lab({ t })
    await s.create({
      args: [
        '--hold',
        '--column',
        'in_progress',
        '--kind',
        'investigation',
      ],
    })
    const held = s.task()
    assert.equal(
      held.column,
      s.column({ role: 'queued' }),
    )
    assert.equal(
      cardState({
        card: held,
        now: Date.now(),
      }).text,
      'talking',
    )
    assert.deepEqual(
      readyBacklog({ state: s.state() }),
      [],
    )
    assert.equal(
      decisionsBlock({
        state: s.state(),
        now: Date.now(),
      }),
      'Open decisions: none',
    )
    assert.throws(
      () => freeTask({
        state: s.state(),
        ref: 'idea',
      }),
      { code: 'TASK_HELD' },
    )
    const host = createHost({
      hydraId: 'lab',
      changed() {},
    })
    t.after(() => host.close())
    assert.throws(
      () => host.continue({
        task: held.id,
        actor: 'web',
        id: 'continue-held',
      }),
      { code: 'TASK_HELD' },
    )
    await assert.rejects(
      async () => host.start({
        task: held.id,
        replacement: 'lost-session',
        actor: 'web',
        id: 'replace-held',
        prompt: 'Do not run',
        settings: {},
      }),
      { code: 'TASK_HELD' },
    )
    const seq = s.state().seq

    for (const args of [
      [
        'start',
        'idea',
      ],
      [
        'start',
        'idea',
        '--via',
        'command',
        '--command',
        'never run',
      ],
      [
        'start',
        'idea',
        '--via',
        'paseo',
      ],
      [
        'start',
        'idea',
        '--via',
        'firstmate',
      ],
      [
        'build',
        'idea',
      ],
      [
        'queue',
        'idea',
        '--behind',
        'missing-worker',
      ],
      [
        'continue',
        'idea',
      ],
      [
        'continue',
        'idea',
        '--check',
      ],
    ]) {
      await assert.rejects(
        async () => s.run({ args: args }),
        { code: 'TASK_HELD' },
      )
      assert.equal(
        s.state().seq,
        seq,
      )
      assert.equal(
        s.task().copy,
        undefined,
      )
      assert.deepEqual(
        s.task().sessionIds,
        [],
      )
    }

    const shown = await s.run({
      args: [
        'show',
        'idea',
      ],
    })
    assert.ok((shown.task as { hold?: unknown }).hold)
    assert.equal(
      replay({
        events: readEvents({ hydraId: 'lab' }),
        state: emptyHydra(),
      }).cards[held.id]!.hold?.id,
      held.hold!.id,
    )
  },
)

test(
  'release records only an owner send newer than the current hold',
  async t => {
    const s = lab({ t })
    await s.create()
    s.message({ id: 'old' })
    t.mock.timers.tick(1000)
    await s.run({
      args: [
        'hold',
        'idea',
        '--reason',
        'Talk about export scope',
      ],
    })
    const hold = s.task().hold!
    s.message({ id: 'same-time' })
    t.mock.timers.tick(1000)
    s.message({
      id: 'hydra-line',
      actor: 'hydra',
    })
    s.message({
      id: 'worker-report',
      actor: 'worker:idea',
    })
    s.message({
      id: 'worker-action',
      action: 'worker',
    })
    const seq = s.state().seq

    for (const id of [
      'old',
      'same-time',
      'hydra-line',
      'worker-report',
      'worker-action',
      'absent',
    ]) {
      await assert.rejects(
        async () => s.run({
          args: [
            'release',
            'idea',
            '--from-message',
            id,
            '--reason',
            'Approved',
          ],
        }),
        { code: 'VALIDATION_ERROR' },
      )
      assert.equal(
        s.state().seq,
        seq,
      )
    }

    s.message({
      id: 'owner-go',
      text: 'Build the exports we agreed on.',
    })
    await assert.rejects(
      async () => s.run({
        args: [
          'release',
          'idea',
          '--from-message',
          'owner-go',
          '--reason',
          'Approved',
          '--actor',
          'worker:idea',
        ],
      }),
      { code: 'OWNER_ONLY' },
    )
    await s.run({
      args: [
        'release',
        'idea',
        '--from-message',
        'owner-go',
        '--reason',
        'Owner gave the go',
        '--actor',
        'hydra',
      ],
    })
    assert.equal(
      s.task().hold,
      undefined,
    )
    assert.equal(
      s.task().column,
      s.column({ role: 'queued' }),
    )
    assert.deepEqual(
      readyBacklog({ state: s.state() }).map(c => c.id),
      [s.task().id],
    )
    const release = readEvents({ hydraId: 'lab' }).findLast(e => e.type === 'task.released')!
    assert.equal(
      release.data.hold,
      hold.id,
    )
    assert.deepEqual(
      release.data.message,
      {
        id: 'owner-go',
        text: 'Build the exports we agreed on.',
        at: new Date().toISOString(),
      },
    )
  },
)

test(
  'a go question waits in Needs you, Hold keeps it held, and an explicit Go closes and releases together',
  async t => {
    const s = lab({ t })
    await s.create({ args: ['--hold'] })
    await s.ask()
    assert.equal(
      s.task().column,
      s.column({ role: 'needs_you' }),
    )
    assert.deepEqual(
      s.task().asks![0]!.options,
      [
        { label: 'Go' },
        { label: 'Hold' },
      ],
    )
    await assert.rejects(
      async () => s.ask(),
      { code: 'VALIDATION_ERROR' },
    )
    t.mock.timers.tick(1000)
    s.message({
      id: 'keep-talking',
      text: 'Hold',
    })
    await s.answer({
      args: [
        '--from-message',
        'keep-talking',
        '--choice',
        'Hold',
        '--actor',
        'hydra',
      ],
    })
    assert.ok(s.task().hold)
    assert.ok(s.task().asks![0]!.answered)
    assert.equal(
      s.task().column,
      s.column({ role: 'queued' }),
    )
    await s.ask()
    t.mock.timers.tick(1000)
    s.message({
      id: 'unclear',
      text: 'Sounds good, but let us discuss the tests first.',
    })
    await assert.rejects(
      async () => s.answer({
        args: [
          '--from-message',
          'unclear',
          '--actor',
          'hydra',
        ],
      }),
      { code: 'VALIDATION_ERROR' },
    )
    await assert.rejects(
      async () => s.answer({
        args: [
          '--choice',
          'Go',
          '--actor',
          'hydra',
        ],
      }),
      { code: 'OWNER_ONLY' },
    )
    assert.ok(s.task().hold)
    assert.equal(
      s.task().asks!.at(-1)!.answered,
      undefined,
    )
    s.message({
      id: 'go',
      text: 'Go ahead with the agreed design.',
    })
    await s.answer({
      args: [
        '--from-message',
        'go',
        '--choice',
        'Go',
        '--actor',
        'hydra',
      ],
    })
    const answered = s.task().asks!.at(-1)!
    assert.equal(
      s.task().hold,
      undefined,
    )
    assert.equal(
      s.task().column,
      s.column({ role: 'queued' }),
    )
    assert.equal(
      answered.choice,
      'Go',
    )
    assert.ok(answered.answered)
    assert.equal(
      answered.fromMessage!.id,
      'go',
    )
    assert.equal(
      decisionsBlock({
        state: s.state(),
        now: Date.now(),
      }),
      'Open decisions: none',
    )
    const events = readEvents({ hydraId: 'lab' })
    const event = events.find(e => e.id === answered.answered)!
    const atAnswer = replay({
      events: events.filter(e => e.seq <= event.seq),
      state: emptyHydra(),
    }).cards[s.task().id]!
    assert.equal(
      atAnswer.hold,
      undefined,
    )
    assert.ok(atAnswer.asks!.at(-1)!.answered)

    await s.run({
      args: [
        'reopen-question',
        'idea',
        answered.id,
        '--answer',
        answered.answered!,
      ],
    })
    assert.ok(s.task().hold)
    assert.equal(
      s.task().column,
      s.column({ role: 'needs_you' }),
    )
    await assert.rejects(
      async () => s.run({
        args: [
          'start',
          'idea',
        ],
      }),
      { code: 'TASK_HELD' },
    )
  },
)

test(
  'replacing or directly releasing a hold closes its old go question without letting it release the new hold',
  async t => {
    const s = lab({ t })
    await s.create({ args: ['--hold'] })
    await s.ask()
    const old = s.task().asks![0]!.id
    t.mock.timers.tick(1000)
    await s.run({
      args: [
        'hold',
        'idea',
        '--reason',
        'A different scope needs discussion',
      ],
    })
    assert.ok(s.task().asks![0]!.closed)
    assert.equal(
      s.task().column,
      s.column({ role: 'queued' }),
    )
    t.mock.timers.tick(1000)
    s.message({ id: 'go' })
    await assert.rejects(
      async () => s.run({
        args: [
          'answer',
          'idea',
          old,
          '--from-message',
          'go',
          '--choice',
          'Go',
          '--actor',
          'hydra',
        ],
      }),
      { code: 'ASK_CLOSED' },
    )
    await s.ask()
    t.mock.timers.tick(1000)
    s.message({ id: 'direct-go' })
    await s.run({
      args: [
        'release',
        'idea',
        '--from-message',
        'direct-go',
        '--reason',
        'Owner approved',
      ],
    })
    assert.equal(
      s.task().hold,
      undefined,
    )
    assert.ok(s.task().asks!.at(-1)!.closed)
    assert.equal(
      s.task().column,
      s.column({ role: 'queued' }),
    )
  },
)

test(
  'go questions require a discussion hold, the owner audience and fixed choices',
  async t => {
    const s = lab({ t })
    await s.create()
    await assert.rejects(
      async () => s.ask(),
      { code: 'VALIDATION_ERROR' },
    )
    await s.run({
      args: [
        'hold',
        'idea',
        '--reason',
        'Talk first',
      ],
    })
    await assert.rejects(
      async () => s.run({
        args: [
          'ask',
          'idea',
          '--kind',
          'go',
          '--question',
          'Go?',
          '--actor',
          'worker:idea',
        ],
      }),
      { code: 'VALIDATION_ERROR' },
    )
    await assert.rejects(
      async () => s.run({
        args: [
          'ask',
          'idea',
          '--to',
          'owner',
          '--kind',
          'go',
          '--question',
          'Go?',
          '--choice',
          'Yes',
          '--actor',
          'hydra',
        ],
      }),
      { code: 'VALIDATION_ERROR' },
    )
    await assert.rejects(
      async () => s.run({
        args: [
          'hold',
          'idea',
          '--reason',
          'Wait',
          '--actor',
          'worker:idea',
        ],
      }),
      { code: 'OWNER_ONLY' },
    )
  },
)

test(
  'a held completed investigation keeps its go question open for the new build scope',
  async t => {
    const s = lab({ t })
    await s.create({
      args: [
        '--kind',
        'investigation',
      ],
    })
    withWriter({
      hydraId: 'lab',
      fn: ({ writer }) => {
        const decision = hydraEvent({
          state: writer.state,
          cardId: s.task().id,
          meta: {
            actor: 'worker:idea',
            at: new Date().toISOString(),
          },
          change: {
            type: 'task.declared',
            data: {
              state: 'done',
              note: 'Report is complete',
            },
          },
        })
        assert.ok('event' in decision)
        writer.append({ event: decision.event })
      },
    })
    assert.equal(
      s.task().column,
      s.column({ role: 'done' }),
    )
    await s.run({
      args: [
        'hold',
        'idea',
        '--reason',
        'Discuss whether to build',
      ],
    })
    assert.equal(
      s.task().column,
      s.column({ role: 'queued' }),
    )
    assert.equal(
      cardState({
        card: s.task(),
        now: Date.now(),
      }).text,
      'talking',
    )
    await s.ask()
    assert.equal(
      s.task().asks!.at(-1)!.closed,
      undefined,
    )
    assert.equal(
      s.task().column,
      s.column({ role: 'needs_you' }),
    )
  },
)

for (const holdOnRead of [
  1,
  2,
]) {
  test(
    `a hold arriving during Paseo model read ${holdOnRead} prevents agent creation`,
    async t => {
      const s = lab({ t })
      fakeDispatch({ root: s.home })
      await s.create({
        args: [
          '--folder',
          s.home,
        ],
      })
      let reads = 0
      let launches = 0
      const client = {
        providers: {
          listModels: async () => {
            reads++

            if (reads === holdOnRead) {
              await s.run({
                args: [
                  'hold',
                  'idea',
                  '--reason',
                  'Discuss before starting',
                ],
              })
            }

            return {
              models: [
                {
                  id: 'default',
                  isDefault: true,
                },
              ],
            }
          },
        },
        agents: {
          create: async () => {
            launches++

            return { id: 'fixture-agent' }
          },
        },
        close: async () => {},
      }
      await assert.rejects(
        async () => startTask({
          hydraId: 'lab',
          task: 'idea',
          via: 'paseo',
          folder: s.home,
          meta: {
            actor: 'web',
            at: new Date().toISOString(),
          },
          connect: async () => client as unknown as PaseoClient,
        }),
        { code: 'TASK_HELD' },
      )
      assert.equal(
        reads,
        holdOnRead,
      )
      assert.equal(
        launches,
        0,
      )
      assert.deepEqual(
        s.task().sessionIds,
        [],
      )
      assert.equal(
        s.task().copy,
        undefined,
      )
    },
  )
}

test(
  'Hydra check includes discussion holds and releases made by the owner',
  async t => {
    const s = lab({ t })
    await s.create()
    const after = s.state().seq
    await s.run({
      args: [
        'hold',
        'idea',
        '--reason',
        'Talk first',
      ],
    })
    t.mock.timers.tick(1000)
    s.message({ id: 'approved' })
    await s.run({
      args: [
        'release',
        'idea',
        '--from-message',
        'approved',
        '--reason',
        'Owner approved',
      ],
    })
    const check = await hydraCheck({
      args: [
        '--hydra',
        'lab',
        '--after',
        String(after),
      ],
    })
    const changes = check.changes as { type: string }[]
    assert.ok(changes.some(event => event.type === 'task.held'))
    assert.ok(changes.some(event => event.type === 'task.released'))
  },
)

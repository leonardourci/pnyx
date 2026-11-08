import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { commands } from '#app/cli.ts'
import { withWriter } from '#app/writer.ts'
import { loadHydra } from '#app/store.ts'
import { emptyHydra, replay } from '#app/reducer.ts'
import { readEvents } from '#app/event-log.ts'
import type { HydraEvent } from '#app/model.ts'
import { eventReasons } from '#hydra/wake-reasons.ts'
import { cardStatus } from './card-status.ts'
import { resumeWaits } from './resume-waits.ts'
import { taskReadiness } from './dependencies.ts'

const hydraId = 'wait-lab'
let root = ''
let saved: NodeJS.ProcessEnv
const state = () => loadHydra({ hydraId }).state
const card = ({ key = 'client' }: { key?: string } = {}) => state().cards[state().keys[key]!]!
type Change = { [Type in HydraEvent['type']]: Pick<Extract<HydraEvent, { type: Type }>, 'type' | 'data'> }[HydraEvent['type']]

function append({
  key = 'base',
  change,
}: {
  key?: string
  change: Change
}) {
  withWriter({
    hydraId,
    fn: ({ writer }) => writer.append({
      event: {
        v: 1,
        id: `synthetic-${writer.state.seq + 1}`,
        seq: writer.state.seq + 1,
        at: new Date().toISOString(),
        actor: 'pnyx',
        cardId: writer.state.keys[key]!,
        ...change,
      },
    }),
  })
}

const resume = () => resumeWaits({
  hydraId,
  state: state(),
})

const pause = ({
  condition,
  dependency = 'base',
  extra = [],
}: {
  condition?: string
  dependency?: string
  extra?: string[]
} = {}) => {
  const args = [
    'status',
    'client',
    'paused',
    '--wait-for',
    dependency,
    ...extra,
    '--actor',
    `worker:${card().id}`,
    '--hydra',
    hydraId,
  ]

  if (condition) {
    args.push(
      '--ready-when',
      condition,
    )
  }

  return commands.task(args)
}

beforeEach(async () => {
  saved = { ...process.env }
  root = mkdtempSync(join(
    tmpdir(),
    'pnyx-waits-',
  ))
  process.env.PNYX_HOME = root
  delete process.env.PNYX_ACTOR
  await commands.hydra([
    'create',
    hydraId,
  ])

  for (const key of [
    'base',
    'client',
  ]) {
    await commands.task([
      'create',
      '--key',
      key,
      '--title',
      key === 'base' ? 'Shared component' : 'Client task',
      '--hydra',
      hydraId,
    ])
  }
})
afterEach(() => {
  process.env = saved
  rmSync(
    root,
    {
      recursive: true,
      force: true,
    },
  )
})

test(
  'a task completion wait resumes once, persists across reload and replays atomically',
  async () => {
    await pause()
    assert.equal(
      card().wait?.condition,
      'task-done',
    )
    assert.equal(
      taskReadiness({
        state: state(),
        card: card(),
      }).ready,
      false,
    )
    assert.equal(
      resume(),
      0,
    )
    assert.equal(
      cardStatus({
        card: card(),
        cards: state().cards,
      }).text,
      'waiting: Shared component',
    )
    append({
      change: {
        type: 'task.declared',
        data: {
          state: 'done',
          note: 'Completed',
        },
      },
    })
    assert.equal(
      resume(),
      1,
    )
    assert.equal(
      card().wait,
      undefined,
    )
    assert.equal(
      card().status?.state,
      'working',
    )
    assert.equal(
      card().steering?.length,
      1,
    )
    assert.match(
      card().steering![0]!.text,
      /Shared component.*task-done/,
    )
    assert.equal(
      resume(),
      0,
    )
    const events = readEvents({ hydraId })
    const resumed = events.find(event => event.type === 'task.wait-resumed')!
    const replayed = replay({
      state: emptyHydra(),
      events,
    })
    assert.equal(
      replayed.cards[card().id]!.steering?.length,
      1,
    )
    assert.equal(
      replayed.cards[card().id]!.wait,
      undefined,
    )
    assert.deepEqual(
      eventReasons({
        state: replayed,
        event: resumed,
      }),
      [],
    )
    assert.equal(
      replayed.contextNotes?.length,
      1,
    )
    assert.match(
      replayed.contextNotes![0]!.text,
      /worker resume queued/,
    )
    await pause()
    await commands.task([
      'status',
      'client',
      'blocked',
      '--note',
      'A separate blocker',
      '--hydra',
      hydraId,
    ])
    assert.equal(
      card().wait,
      undefined,
    )
    assert.equal(
      resume(),
      0,
    )
    assert.equal(
      card().status?.state,
      'blocked',
    )
  },
)

for (const condition of [
  'pr-opened',
  'pr-merged',
]) {
  test(
    `${condition} waits on recorded pull request state and carries its link`,
    async () => {
      await pause({ condition })
      assert.equal(
        resume(),
        0,
      )
      const url = 'https://github.com/example/project/pull/42'
      append({
        change: {
          type: 'card.linked',
          data: {
            url,
            before: null,
            after: {
              kind: 'github_pr',
              url,
              state: 'open',
            },
          },
        },
      })

      if (condition === 'pr-merged') {
        assert.equal(
          resume(),
          0,
        )
        append({
          change: {
            type: 'card.linked',
            data: {
              url,
              before: {
                kind: 'github_pr',
                url,
                state: 'open',
              },
              after: {
                kind: 'github_pr',
                url,
                state: 'merged',
              },
            },
          },
        })
      }

      assert.equal(
        resume(),
        1,
      )
      assert.ok(card().steering![0]!.text.includes(url))
      assert.equal(
        resume(),
        0,
      )
    },
  )
}

test(
  'ready dependencies preserve holds, permissions, compaction and helper leases',
  async () => {
    await pause({ condition: 'pr-opened' })
    append({
      key: 'client',
      change: {
        type: 'task.held',
        data: { reason: 'Discuss scope' },
      },
    })
    const url = 'https://github.com/example/project/pull/42'
    append({
      change: {
        type: 'card.linked',
        data: {
          url,
          before: null,
          after: {
            kind: 'github_pr',
            url,
            state: 'open',
          },
        },
      },
    })
    assert.equal(
      resume(),
      0,
    )
    const hold = card().hold!
    append({
      key: 'client',
      change: {
        type: 'task.released',
        data: {
          hold: hold.id,
          message: {
            id: 'go',
            at: new Date().toISOString(),
            text: 'Continue',
          },
        },
      },
    })
    append({
      key: 'client',
      change: {
        type: 'task.asked',
        data: {
          id: 'question',
          audience: 'owner',
          question: 'Choose an option?',
        },
      },
    })
    assert.equal(
      resume(),
      0,
    )
    await commands.task([
      'status',
      'client',
      'blocked',
      '--note',
      'Waiting for owner choice',
      '--hydra',
      hydraId,
    ])
    assert.equal(
      card().wait?.task,
      card({ key: 'base' }).id,
    )
    append({
      key: 'client',
      change: {
        type: 'task.ask.closed',
        data: {
          ask: 'question',
          reason: 'Resolved',
          evidence: 'Owner chose the default',
        },
      },
    })
    append({
      key: 'client',
      change: {
        type: 'task.permission',
        data: {
          id: 'permission',
          session: 'session',
          tool: 'Write',
          input: {},
          status: 'pending',
        },
      },
    })
    assert.equal(
      resume(),
      0,
    )
    append({
      key: 'client',
      change: {
        type: 'task.permission',
        data: {
          id: 'permission',
          session: 'session',
          tool: 'Write',
          input: {},
          status: 'allow',
        },
      },
    })
    append({
      key: 'client',
      change: {
        type: 'card.pushed',
        data: {
          key: 'client',
          agent: {
            provider: 'codex',
            sessionId: 'session',
          },
        },
      },
    })
    append({
      key: 'client',
      change: {
        type: 'session.compaction',
        data: {
          kind: 'status',
          operation: {
            id: 'compact',
            session: 'codex:session',
            trigger: 'manual',
            state: 'running',
            startedAt: '2026-10-20T10:00:00Z',
          },
        },
      },
    })
    assert.equal(
      resume(),
      0,
    )
    append({
      key: 'client',
      change: {
        type: 'session.compaction',
        data: {
          kind: 'status',
          operation: {
            id: 'compact',
            session: 'codex:session',
            trigger: 'manual',
            state: 'done',
            startedAt: '2026-10-20T10:00:00Z',
          },
        },
      },
    })
    append({
      key: 'client',
      change: {
        type: 'hydra.helper-started',
        data: {
          id: 'helper-batch',
          tasks: [card().id],
          prompt: 'Synthetic helper work',
          seqs: [],
        },
      },
    })
    assert.equal(
      resume(),
      0,
    )
    append({
      key: 'client',
      change: {
        type: 'hydra.helper-finished',
        data: {
          batch: 'helper-batch',
          outcomes: [],
        },
      },
    })
    assert.equal(
      resume(),
      1,
    )
  },
)

test(
  'wait declarations reject invalid conditions, mixed timers, missing dependencies and cycles',
  async () => {
    for (const options of [
      { condition: 'unknown' },
      { dependency: 'missing' },
      { dependency: 'client' },
      {
        extra: [
          '--until',
          'in 2 hours',
        ],
      },
      { extra: ['--hold'] },
    ]) {
      await assert.rejects(() => pause(options))
    }

    await commands.task([
      'depend',
      'base',
      '--on',
      'client',
      '--hydra',
      hydraId,
    ])
    await assert.rejects(
      () => pause(),
      /dependency cycle/,
    )
    await commands.task([
      'undepend',
      'base',
      '--on',
      'client',
      '--hydra',
      hydraId,
    ])
    await pause()
    const beforeRefusal = readEvents({ hydraId })
    await assert.rejects(
      () => commands.task([
        'status',
        'base',
        'paused',
        '--wait-for',
        'client',
        '--hydra',
        hydraId,
      ]),
      /dependency cycle/,
    )
    await assert.rejects(
      () => commands.task([
        'depend',
        'base',
        '--on',
        'client',
        '--hydra',
        hydraId,
      ]),
      /dependency cycle/,
    )
    assert.deepEqual(
      readEvents({ hydraId }),
      beforeRefusal,
    )
  },
)

test(
  'a paused declaration without a dependency shows its note',
  async () => {
    await commands.task([
      'status',
      'client',
      'paused',
      '--note',
      'Waiting for review',
      '--actor',
      `worker:${card().id}`,
      '--hydra',
      hydraId,
    ])
    assert.equal(
      cardStatus({ card: card() }).text,
      'waiting: Waiting for review',
    )
    assert.equal(
      resume(),
      0,
    )
  },
)

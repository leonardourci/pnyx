import { fireReminders } from '#tasks/fire-reminders.ts'
import { emptyHydra, reduce, replay } from '#app/reducer.ts'
import { readEvents } from '#app/event-log.ts'
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
// TypeScript cannot rewrite the web alias's .ts extension when checking this test.
import { pageTitle } from '../web/src/app/view.ts'
import { beforeAll, expect, test } from 'vitest'
import { rows, startPnyx, until, type Pnyx } from './setup/pnyx.ts'

let pnyx: Pnyx

beforeAll(async () => {
  pnyx = await startPnyx()
})

test(
  'a task moves across the board as its worker and Hydra report, and its dependent becomes ready once it is done',
  async () => {
    const hydra = await pnyx.hydra()
    const board = {
      queued: await hydra.column({ role: 'queued' }),
      in_progress: await hydra.column({ role: 'in_progress' }),
      needs_you: await hydra.column({ role: 'needs_you' }),
      parked: await hydra.column({ role: 'parked' }),
      done: await hydra.column({ role: 'done' }),
    }
    const folder = hydra.folder({ name: 'export' })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'Build the export',
        '--key',
        'build',
        '--folder',
        folder,
        '--brief',
        'Write the CSV export',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'Ship the export',
        '--key',
        'ship',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'depend',
        'ship',
        '--on',
        'build',
      ],
    })
    expect((await hydra.task({ key: 'build' })).column).toBe(board.queued)
    expect((await hydra.task({ key: 'ship' })).readiness).toMatchObject({
      ready: false,
      unmet: [expect.objectContaining({ title: 'Build the export' })],
    })

    const started = await hydra.owner({
      args: [
        'task',
        'start',
        'build',
      ],
    })
    expect(started.agent).toMatchObject({
      harness: 'claude',
      host: 'pnyx',
    })
    const worker = await hydra.agent({ cwd: folder })
    expect(worker.received).toHaveLength(1)
    expect(worker.received[0]).toContain('Write the CSV export')
    expect((await hydra.task({ key: 'build' })).column).toBe(board.in_progress)

    const again = await hydra.ownerRefused({
      args: [
        'task',
        'start',
        'build',
      ],
    })
    expect(again.code).toBe('SESSION_CONFLICT')
    expect(pnyx.claude.sessions.filter(session => session.cwd === folder)).toEqual([worker])

    const session = await hydra.chat({ text: 'what does the export need?' })
    const asked = await hydra.as({ session }).run({
      args: [
        'task',
        'ask',
        'build',
        '--to',
        'owner',
        '--question',
        'Include archived invoices?',
        '--context',
        `Archived invoices change the export totals. After your choice I will implement the filter. [Export](pnyx-task:${(await hydra.task({ key: 'build' })).id})`,
        '--choice',
        'Only open',
        '--choice',
        'Include archived',
        '--recommend',
        '1',
        '--reason',
        'Only the owner knows the accounting rule',
      ],
    })
    expect((await hydra.task({ key: 'build' })).column).toBe(board.needs_you)

    await hydra.owner({
      args: [
        'task',
        'answer',
        'build',
        asked.ask,
        '--text',
        'No, only open ones',
      ],
    })
    await until({
      what: 'the answer to reach Hydra, who asked',
      check: () => session.received.some(message => message.includes('No, only open ones')),
    })
    expect(worker.received.some(message => message.includes('No, only open ones'))).toBe(false)
    expect((await hydra.task({ key: 'build' })).column).toBe(board.in_progress)

    await hydra.as({ session: worker }).run({
      args: [
        'task',
        'status',
        'build',
        'done',
        '--note',
        'Export written',
      ],
    })
    expect(await hydra.task({ key: 'build' })).toMatchObject({
      column: board.done,
      status: 'done: Export written',
    })
    expect((await hydra.task({ key: 'ship' })).readiness).toEqual({
      ready: true,
      reasons: [],
      unmet: [],
    })
  },
)

test(
  'dependencies refuse a cycle or an unknown task and leave independent work ready',
  async () => {
    const hydra = await pnyx.hydra()

    for (const key of [
      'first',
      'second',
      'alone',
    ]) {
      await hydra.owner({
        args: [
          'task',
          'create',
          '--title',
          key,
          '--key',
          key,
        ],
      })
    }

    await hydra.owner({
      args: [
        'task',
        'depend',
        'second',
        '--on',
        'first',
      ],
    })
    expect((await hydra.ownerRefused({
      args: [
        'task',
        'depend',
        'first',
        '--on',
        'second',
      ],
    })).code).toBe('DEPENDENCY_CYCLE')
    expect((await hydra.ownerRefused({
      args: [
        'task',
        'depend',
        'first',
        '--on',
        'no-such-task',
      ],
    })).code).toBe('NOT_FOUND')
    expect((await hydra.task({ key: 'first' })).readiness.ready).toBe(true)
    expect((await hydra.task({ key: 'alone' })).readiness.ready).toBe(true)
    expect((await hydra.task({ key: 'second' })).readiness.ready).toBe(false)

    await hydra.owner({
      args: [
        'task',
        'undepend',
        'second',
        '--on',
        'first',
      ],
    })
    expect((await hydra.task({ key: 'second' })).readiness.ready).toBe(true)
  },
)

test(
  'a held task refuses to start until the owner releases it from a newer message',
  async () => {
    const hydra = await pnyx.hydra()
    const folder = hydra.folder({ name: 'held' })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'Rename the API',
        '--key',
        'rename',
        '--folder',
        folder,
        '--hold',
      ],
    })
    expect((await hydra.ownerRefused({
      args: [
        'task',
        'start',
        'rename',
      ],
    })).code).toBe('TASK_HELD')
    expect(pnyx.claude.sessions.some(session => session.cwd === folder)).toBe(false)

    const go = await hydra.owner({
      args: [
        'hydra',
        'send',
        '--text',
        'Go ahead with the rename',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'release',
        'rename',
        '--from-message',
        go.message,
        '--reason',
        'The owner said go',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'start',
        'rename',
      ],
    })
    expect((await hydra.agent({ cwd: folder })).received).toHaveLength(1)
  },
)

test(
  'a hold is not released by a message sent before it or by one Hydra wrote, and the task still cannot start',
  async () => {
    const hydra = await pnyx.hydra()
    const folder = hydra.folder({ name: 'still-held' })
    const before = await hydra.owner({
      args: [
        'hydra',
        'send',
        '--text',
        'Maybe rename the API',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'Rename the API',
        '--key',
        'still-held',
        '--folder',
        folder,
        '--hold',
      ],
    })
    const byHydra = await hydra.owner({
      args: [
        'hydra',
        'send',
        '--text',
        'Go ahead with the rename',
        '--actor',
        'hydra',
        '--reason',
        'Hydra decides to go',
      ],
    })

    for (const message of [
      before.message,
      byHydra.message,
    ]) {
      expect(
        (await hydra.ownerRefused({
          args: [
            'task',
            'release',
            'still-held',
            '--from-message',
            message,
            '--reason',
            'Released',
          ],
        })).code,
        message,
      ).toBe('VALIDATION_ERROR')
    }

    expect((await hydra.ownerRefused({
      args: [
        'task',
        'start',
        'still-held',
      ],
    })).code).toBe('TASK_HELD')
  },
)

test(
  'a manual move can be undone until the card moves again, and apply --check previews without writing',
  async () => {
    const hydra = await pnyx.hydra()
    const board = {
      queued: await hydra.column({ role: 'queued' }),
      in_progress: await hydra.column({ role: 'in_progress' }),
      needs_you: await hydra.column({ role: 'needs_you' }),
      parked: await hydra.column({ role: 'parked' }),
      done: await hydra.column({ role: 'done' }),
    }
    await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'Later work',
        '--key',
        'later',
      ],
    })

    const move = async ({ to }: { to: string }) => {
      const preview = await hydra.owner({
        args: [
          'move',
          'later',
          to,
        ],
      })
      expect(preview.confirmation).toBe('needed')
      expect((await hydra.task({ key: 'later' })).column).not.toBe(to)

      return hydra.owner({
        args: [
          'move',
          'later',
          to,
          '--confirm',
          preview.token,
        ],
      })
    }

    const parked = await move({ to: board.parked })
    expect((await hydra.task({ key: 'later' })).column).toBe(board.parked)
    await hydra.owner({
      args: [
        'undo',
        parked.event.id,
      ],
    })
    expect((await hydra.task({ key: 'later' })).column).toBe(board.queued)

    const again = await move({ to: board.parked })
    await move({ to: board.done })
    expect((await hydra.ownerRefused({
      args: [
        'undo',
        again.event.id,
      ],
    })).code).toBe('CONFLICT')
    expect((await hydra.task({ key: 'later' })).column).toBe(board.done)

    const seq = () => rows<{ seq: string }>({
      text: 'select seq from hydras where id = $1',
      values: [hydra.id],
    })[0]!.seq
    const before = seq()
    const preview = await hydra.owner({
      args: [
        'apply',
        '--check',
        '--file',
        '-',
      ],
      input: JSON.stringify({
        version: 1,
        changes: [
          {
            op: 'task.create',
            title: 'Only a preview',
            key: 'preview',
          },
        ],
      }),
    })
    expect(preview).toMatchObject({
      applied: false,
      operations: [
        {
          op: 'task.create',
          state: 'planned',
        },
      ],
    })
    expect(seq()).toBe(before)
    expect((await hydra.ownerRefused({
      args: [
        'task',
        'show',
        'preview',
      ],
    })).code).toBe('NOT_FOUND')
  },
)

test(
  'tasks can be nested, moved between parents and detached with one level enforced',
  async () => {
    const hydra = await pnyx.hydra()
    const parent = await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'Export',
      ],
    })
    const other = await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'Import',
      ],
    })
    const child = await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'CSV',
      ],
    })
    const leaf = await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'Headers',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'parent',
        child.card.id,
        parent.card.id,
      ],
    })
    expect((await hydra.task({ key: child.card.id })).parent).toBe(parent.card.id)
    expect((await hydra.ownerRefused({
      args: [
        'task',
        'parent',
        parent.card.id,
        child.card.id,
      ],
    })).code).toBe('VALIDATION_ERROR')
    expect((await hydra.ownerRefused({
      args: [
        'task',
        'parent',
        leaf.card.id,
        child.card.id,
      ],
    })).code).toBe('VALIDATION_ERROR')
    expect((await hydra.ownerRefused({
      args: [
        'task',
        'parent',
        parent.card.id,
        other.card.id,
      ],
    })).code).toBe('VALIDATION_ERROR')
    await hydra.owner({
      args: [
        'task',
        'parent',
        child.card.id,
        other.card.id,
      ],
    })
    expect((await hydra.task({ key: child.card.id })).parent).toBe(other.card.id)
    await hydra.owner({
      args: [
        'task',
        'parent',
        child.card.id,
        'none',
      ],
    })
    expect((await hydra.task({ key: child.card.id })).parent).toBe('none')
    expect((await hydra.ownerRefused({
      args: [
        'task',
        'parent',
        child.card.id,
        child.card.id,
      ],
    })).code).toBe('VALIDATION_ERROR')
  },
)

test(
  'parent retention waits for every child and reopens when a child resumes',
  async () => {
    const hydra = await pnyx.hydra()
    await hydra.owner({
      args: [
        'task',
        'create',
        '--key',
        'family',
        '--title',
        'Release',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--key',
        'part',
        '--title',
        'Export',
        '--parent',
        'family',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--key',
        'second-part',
        '--title',
        'Validate',
        '--parent',
        'family',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'status',
        'family',
        'done',
        '--note',
        'Parent work completed',
      ],
    })
    expect(rows({
      text: 'select done_at, hidden from cards where hydra_id = $1 and key = $2',
      values: [
        hydra.id,
        'family',
      ],
    })).toEqual([
      {
        done_at: null,
        hidden: false,
      },
    ])
    await hydra.owner({
      args: [
        'task',
        'status',
        'part',
        'done',
        '--note',
        'Child completed',
      ],
    })
    expect(rows({
      text: 'select done_at, hidden from cards where hydra_id = $1 and key = $2',
      values: [
        hydra.id,
        'family',
      ],
    })).toEqual([
      {
        done_at: null,
        hidden: false,
      },
    ])
    await hydra.owner({
      args: [
        'task',
        'status',
        'second-part',
        'done',
        '--note',
        'Validation completed',
      ],
    })
    expect(rows({
      text: 'select done_at from cards where hydra_id = $1 and key = $2',
      values: [
        hydra.id,
        'family',
      ],
    })[0]?.done_at).toBeTypeOf('string')
    await hydra.owner({
      args: [
        'task',
        'status',
        'part',
        'working',
        '--note',
        'Child resumed',
      ],
    })
    expect(rows({
      text: 'select done_at, hidden from cards where hydra_id = $1 and key = $2',
      values: [
        hydra.id,
        'family',
      ],
    })).toEqual([
      {
        done_at: null,
        hidden: false,
      },
    ])
    await pnyx.restart()
    expect(rows({
      text: 'select done_at, hidden from cards where hydra_id = $1 and key = $2',
      values: [
        hydra.id,
        'family',
      ],
    })).toEqual([
      {
        done_at: null,
        hidden: false,
      },
    ])
  },
)

test(
  'a retried write answers for its own declaration from the task as it is now, and with the task id alone once the task moved to another Hydra',
  async () => {
    const hydra = await pnyx.hydra()
    const other = await pnyx.hydra()
    const created = await hydra.owner({
      args: [
        'task',
        'create',
        '--key',
        'retried',
        '--title',
        'Retried',
      ],
    })
    const taskId = created.card.id as string
    const declare = [
      'task',
      'status',
      'retried',
      'working',
      '--note',
      'First pass',
      '--event-id',
      'retried-declaration',
    ]
    const first = await hydra.owner({ args: declare })
    expect(first.notification).toBe('No Hydra wake from this lifecycle declaration')
    const later = await hydra.owner({
      args: [
        'task',
        'status',
        taskId,
        'blocked',
        '--note',
        'Waiting on access',
      ],
    })
    expect(later.notification).toBe('Hydra wake eligible; owner delivery not confirmed')
    expect(later.card.revision).toBeGreaterThan(first.card.revision)

    const retried = await hydra.owner({ args: declare })
    expect(retried.duplicate).toBe('event id already applied; nothing appended')
    expect(retried.event).toEqual(first.event)
    expect(retried.notification).toBe('No Hydra wake from this lifecycle declaration')
    expect(retried.card).toEqual(later.card)

    await hydra.owner({
      args: [
        'task',
        'move',
        taskId,
        '--to-hydra',
        other.id,
      ],
    })
    const moved = await hydra.owner({ args: declare })
    expect(moved.duplicate).toBe('event id already applied; nothing appended')
    expect(moved.event).toEqual(first.event)
    expect(moved.card).toEqual({ id: taskId })
  },
)

test(
  'arrange retries remain duplicates after their peer changes family',
  async () => {
    const hydra = await pnyx.hydra()
    await hydra.owner({
      args: [
        'task',
        'create',
        '--key',
        'a',
        '--title',
        'Atlas',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--key',
        'b',
        '--title',
        'Boreal',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--key',
        'p',
        '--title',
        'Parent',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'arrange',
        'a',
      ],
    })
    const args = [
      'task',
      'arrange',
      'a',
      '--before',
      'b',
      '--event-id',
      'constructor',
    ]
    await hydra.owner({ args })
    await hydra.owner({
      args: [
        'task',
        'parent',
        'b',
        'p',
      ],
    })
    expect((await hydra.owner({ args })).duplicate).toBe('event id already applied; nothing appended')
  },
)

test(
  'untracked and hook pushes refuse grandchildren before persisting them',
  async () => {
    const id = 'unconfigured-depth'
    const folder = join(
      process.env.PNYX_HOME!,
      'hydras',
      id,
    )
    mkdirSync(
      folder,
      { recursive: true },
    )
    const events = [
      {
        seq: 1,
        id: 'root-push',
        cardId: 'untracked-root',
        data: {
          key: 'untracked-root',
          title: 'Root',
        },
      },
      {
        seq: 2,
        id: 'child-push',
        cardId: 'untracked-child',
        data: {
          key: 'untracked-child',
          title: 'Child',
          parentId: 'untracked-root',
        },
      },
    ].map(event => JSON.stringify({
      v: 1,
      type: 'card.pushed',
      at: '2026-11-17T00:00:00Z',
      actor: 'cli',
      ...event,
    })).join('\n')
    writeFileSync(
      join(
        folder,
        'events.jsonl',
      ),
      `${events}\n`,
    )
    const hydra = await pnyx.hydra({
      id,
      create: false,
    })
    expect((await hydra.ownerRefused({
      args: [
        'push',
        '--key',
        'untracked-leaf',
        '--file',
        '-',
      ],
      input: JSON.stringify({
        title: 'Leaf',
        parent: 'untracked-child',
      }),
    })).code).toBe('VALIDATION_ERROR')
    expect((await hydra.ownerRefused({
      args: [
        'push',
        '--key',
        'hook-leaf',
        '--file',
        '-',
      ],
      input: JSON.stringify({
        title: 'Hook leaf',
        parent: 'untracked-child',
        agent: {
          provider: 'claude',
          sessionId: 'hook-leaf',
        },
        source: {
          adapter: 'hooks',
          objectId: 'hook-leaf',
          observedAt: '2026-11-17T00:00:00Z',
        },
      }),
    })).code).toBe('VALIDATION_ERROR')
    expect((await hydra.ownerRefused({
      args: [
        'task',
        'show',
        'untracked-leaf',
      ],
    })).code).toBe('NOT_FOUND')
    expect((await hydra.ownerRefused({
      args: [
        'task',
        'show',
        'hook-leaf',
      ],
    })).code).toBe('NOT_FOUND')
  },
)

test(
  'a reminder-only task stays out of project and Hydra waiting counts',
  async () => {
    const id = 'reminder-summary'
    const folder = join(
      process.env.PNYX_HOME!,
      'hydras',
      id,
    )
    mkdirSync(
      folder,
      { recursive: true },
    )
    const path = join(
      folder,
      'repository',
    )
    mkdirSync(path)
    const events = [
      {
        seq: 1,
        id: 'project',
        cardId: '$projects',
        type: 'hydra.project',
        data: {
          before: null,
          after: {
            path,
            name: 'reminder-repository',
            detached: false,
          },
          sharedWith: [],
        },
      },
      {
        seq: 2,
        id: 'task',
        cardId: 'reminded-task',
        type: 'card.pushed',
        data: {
          key: 'reminded',
          title: 'Check the reminder',
          project: path,
        },
      },
      {
        seq: 3,
        id: 'reminder',
        cardId: 'reminded-task',
        type: 'task.reminder',
        data: {
          before: null,
          after: '2026-11-16T00:00:00Z',
        },
      },
      {
        seq: 4,
        id: 'due',
        cardId: 'reminded-task',
        type: 'task.reminder-due',
        data: {
          reminder: 'reminder',
          column: 'needs_you',
          grouped: true,
          message: {
            action: 'send',
            text: 'Reminder due',
          },
        },
      },
    ].map(event => JSON.stringify({
      v: 1,
      at: '2026-11-16T00:00:00Z',
      actor: 'cli',
      ...event,
    })).join('\n')
    writeFileSync(
      join(
        folder,
        'events.jsonl',
      ),
      `${events}\n`,
    )
    const hydra = await pnyx.hydra({
      id,
      create: false,
    })
    await hydra.owner({
      args: [
        'task',
        'show',
        'reminded',
      ],
    })
    expect(rows<{
      summary: {
        asks: number
        projects: { asks: number }[]
      }
    }>({
      text: 'select summary from hydras where id = $1',
      values: [id],
    })[0]?.summary).toMatchObject({
      asks: 0,
      projects: [expect.objectContaining({ asks: 0 })],
    })
  },
)

test(
  'predicting prototype-named events leaves the previous Hydra untouched',
  () => {
    for (const id of [
      'constructor',
      '__proto__',
    ]) {
      const before = emptyHydra()
      const event = {
        v: 1 as const,
        seq: 1,
        id,
        at: '2026-11-17T00:00:00Z',
        actor: 'cli',
        cardId: 'predicted-task',
        type: 'card.pushed' as const,
        data: {
          key: 'predicted-task',
          title: 'Prediction',
        },
      }
      const after = reduce({
        state: before,
        event,
      })
      expect(before.eventIds).toEqual({})
      expect(before.cards).toEqual({})
      expect(before.seq).toBe(0)
      expect(after.eventIds[id]).toBe(1)
      expect(after.cards['predicted-task']?.title).toBe('Prediction')
      expect(reduce({
        state: before,
        event,
      })).toEqual(after)
    }
  },
)

async function placementFamily() {
  const hydra = await pnyx.hydra()
  const entries = [
    { key: 'first' },
    { key: 'parent' },
    {
      key: 'child',
      parent: 'parent',
    },
    { key: 'last' },
    {
      key: 'sibling',
      parent: 'parent',
    },
  ]

  for (const entry of entries) {
    const args = [
      'task',
      'create',
      '--key',
      entry.key,
      '--title',
      entry.key,
    ]

    if (entry.parent) {
      args.push(
        '--parent',
        entry.parent,
      )
    }

    await hydra.owner({ args })
  }

  const parent = (await hydra.task({ key: 'parent' })).id
  const child = (await hydra.task({ key: 'child' })).id
  const order = ({ parent }: { parent?: string } = {}) => rows<{ key: string }>({
    text: 'select key from cards where hydra_id = $1 and parent_id is not distinct from $2::text and key = any($3::text[]) order by coalesce(rank, created_seq)',
    values: [
      hydra.id,
      parent ?? null,
      entries.map(entry => entry.key),
    ],
  }).map(card => card.key)

  return {
    hydra,
    parent,
    child,
    order,
  }
}

test(
  'detaching before a root records one change, retries once and undoes the complete sibling placement',
  async () => {
    const {
      hydra,
      parent,
      child,
      order,
    } = await placementFamily()
    await hydra.owner({
      args: [
        'task',
        'arrange',
        'child',
      ],
    })
    const siblings = order({ parent })
    expect(siblings).toEqual([
      'sibling',
      'child',
    ])
    const before = readEvents({ hydraId: hydra.id })
    const args = [
      'task',
      'parent',
      'child',
      'none',
      '--before',
      'first',
      '--event-id',
      'parent-before-root',
    ]
    const placed = await hydra.owner({ args })
    expect((await hydra.task({ key: 'child' })).parent).toBe('none')
    expect(order()).toEqual([
      'child',
      'first',
      'parent',
      'last',
    ])
    const events = readEvents({ hydraId: hydra.id })
    expect(events).toHaveLength(before.length + 1)
    expect((await hydra.owner({ args })).duplicate).toBe('event id already applied; nothing appended')
    expect(readEvents({ hydraId: hydra.id })).toHaveLength(events.length)
    await hydra.owner({
      args: [
        'undo',
        placed.event.id,
      ],
    })
    expect((await hydra.task({ key: 'child' })).parent).toBe(parent)
    expect(order({ parent })).toEqual(siblings)
    const event = events.at(-1)!

    if (event.type !== 'card.pushed') {
      throw new Error('Expected the parent event')
    }

    expect(event.data.rank).toBeTypeOf('number')
    const legacy = {
      ...event,
      data: {
        ...event.data,
        before: { ...event.data.before },
      },
    }
    delete legacy.data.rank
    delete legacy.data.before.rank
    const state = replay({
      state: emptyHydra(),
      events: events.slice(
        0,
        -1,
      ),
    })
    const rank = state.cards[child]!.rank
    const restored = reduce({
      state,
      event: legacy,
    }).cards[child]!
    expect(restored.parentId).toBeUndefined()
    expect(restored.rank).toBe(rank)
  },
)

test(
  'detaching without a target places the child at the end of its project roots',
  async () => {
    const {
      hydra,
      parent,
      order,
    } = await placementFamily()
    await hydra.owner({
      args: [
        'task',
        'parent',
        'child',
        'none',
      ],
    })
    expect(order()).toEqual([
      'first',
      'parent',
      'last',
      'child',
    ])
    expect(order({ parent })).toEqual(['sibling'])
  },
)

test(
  'a refused root placement changes neither parent nor rank and raw pushes cannot supply rank',
  async () => {
    const {
      hydra,
      child,
    } = await placementFamily()
    const repository = hydra.folder({ name: 'Other-project' })
    await hydra.owner({
      args: [
        'project',
        'add',
        repository,
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--key',
        'other',
        '--title',
        'Other root',
        '--project',
        repository,
      ],
    })
    const snapshot = () => rows<{
      parent_id: string | null
      rank: number | null
      updated_seq: number
    }>({
      text: 'select parent_id, rank, updated_seq from cards where hydra_id = $1 and id = $2',
      values: [
        hydra.id,
        child,
      ],
    })
    const before = snapshot()

    for (const target of [
      'sibling',
      'other',
    ]) {
      expect((await hydra.ownerRefused({
        args: [
          'task',
          'parent',
          'child',
          'none',
          '--before',
          target,
        ],
      })).code).toBe('CONFLICT')
      expect(snapshot()).toEqual(before)
    }

    expect((await hydra.ownerRefused({
      args: [
        'push',
        '--key',
        'child',
        '--file',
        '-',
      ],
      input: JSON.stringify({
        parent: null,
        rank: 0,
      }),
    })).code).toBe('VALIDATION_ERROR')
    expect(snapshot()).toEqual(before)
  },
)

test(
  'settings take precedence over the task title and truncation keeps a whole Unicode code point',
  () => {
    expect(pageTitle({
      hydra: 'Poseidon',
      page: 'settings',
      taskTitle: 'Add the cart',
    })).toBe('Settings · Poseidon · Pnyx')
    expect(pageTitle({
      hydra: 'Poseidon',
      taskTitle: '0123456789 0123456789 0123456789 0123456789 0123456789 123456 extra',
    })).toBe('0123456789 0123456789 0123456789 0123456789 0123456789… · Poseidon · Pnyx')
    expect(pageTitle({
      hydra: 'Poseidon',
      taskTitle: '01234567890123456789012345678901234567890123456789012345678🚀extra',
    })).toBe('01234567890123456789012345678901234567890123456789012345678🚀… · Poseidon · Pnyx')
  },
)

test(
  'owner questions require a decision, context, card link, choices and recommendation; updates never ask for a decision',
  async () => {
    const hydra = await pnyx.hydra()
    const { worker } = await hydra.startTask({
      key: 'questions',
      harness: 'codex',
    })
    const session = await hydra.chat({ text: 'Decide export scope' })
    const asHydra = hydra.as({ session })
    const card = await hydra.task({ key: 'questions' })
    const context = `Archived invoices change totals. After the answer I will build the export. [Export \\[scope\\]](pnyx-task:${card.id})`
    const fields = [
      [
        '--question',
        'Include archived invoices?',
      ],
      [
        '--context',
        context,
      ],
      [
        '--choice',
        'Only open',
        '--choice',
        'Include archived',
      ],
      [
        '--recommend',
        '1',
      ],
    ]

    for (let omitted = 0; omitted < fields.length; omitted++) {
      const refused = await asHydra.refused({
        args: [
          'task',
          'ask',
          'questions',
          '--to',
          'owner',
          ...fields.filter((
            _,
            index,
          ) => index !== omitted).flat(),
          '--reason',
          'Accounting decision',
        ],
      })
      expect(refused.code).toBe('VALIDATION_ERROR')
    }

    expect((await asHydra.refused({
      args: [
        'task',
        'ask',
        'questions',
        '--to',
        'owner',
        ...fields[0]!,
        ...fields[1]!,
        '--choice',
        'Only open',
        '--recommend',
        '1',
        '--reason',
        'Accounting decision',
      ],
    })).code).toBe('VALIDATION_ERROR')

    for (const question of [
      '?',
      'Ready for review',
      'Ship CSV? Or JSON?',
    ]) {
      expect((await asHydra.refused({
        args: [
          'task',
          'ask',
          'questions',
          '--to',
          'owner',
          '--question',
          question,
          ...fields.slice(1).flat(),
          '--reason',
          'Accounting decision',
        ],
      })).code).toBe('VALIDATION_ERROR')
    }

    for (const badContext of [
      'Totals change after the answer.',
      `[Export](pnyx-task:${card.id})`,
      '[Wrong](pnyx-task:another-card)',
      `Totals change after the answer. ](pnyx-task:${card.id})`,
    ]) {
      expect((await asHydra.refused({
        args: [
          'task',
          'ask',
          'questions',
          '--to',
          'owner',
          ...fields[0]!,
          '--context',
          badContext,
          ...fields[2]!,
          ...fields[3]!,
          '--reason',
          'Accounting decision',
        ],
      })).code).toBe('VALIDATION_ERROR')
    }

    await hydra.as({ session: worker }).run({
      args: [
        'task',
        'status',
        'questions',
        'needs_you',
        '--note',
        'Ready for review',
      ],
    })
    const inProgress = await hydra.column({ role: 'in_progress' })
    expect((await hydra.task({ key: 'questions' })).column).toBe(inProgress)
    const beforeReminder = await hydra.owner({
      args: [
        'task',
        'show',
        card.id,
        '--full',
      ],
    })
    expect(beforeReminder.task.status).toMatchObject({ state: 'needs_you' })

    const confirmColumnChange = async ({ args }: { args: string[] }) => {
      const preview = await hydra.owner({ args })
      expect(preview).toMatchObject({
        confirmation: 'needed',
        token: expect.stringMatching(/\S/),
      })

      const result = await hydra.owner({
        args: [
          ...args,
          '--confirm',
          preview.token,
        ],
      })
      expect(result.confirmation).not.toBe('needed')
    }

    await hydra.owner({
      args: [
        'column',
        'create',
        '--title',
        'Reminder updates',
        '--id',
        'custom:reminder-updates',
      ],
    })
    await confirmColumnChange({
      args: [
        'column',
        'rule',
        'custom:reminder-updates',
        '--when',
        'reminder-due,!done',
        '--reason',
        'Custom reminder placement',
      ],
    })
    await confirmColumnChange({
      args: [
        'column',
        'reorder',
        'custom:reminder-updates',
        '--before',
        inProgress,
      ],
    })
    const due = new Date(Date.now() + 60_000).toISOString()
    await hydra.owner({
      args: [
        'task',
        'remind',
        'questions',
        due,
      ],
    })
    fireReminders({
      hydraId: hydra.id,
      at: new Date(Date.parse(due) + 1).toISOString(),
    })
    expect((await hydra.task({ key: 'questions' })).column).toBe(inProgress)
    await confirmColumnChange({
      args: [
        'column',
        'delete',
        'custom:reminder-updates',
        '--to',
        inProgress,
      ],
    })
    const afterReminder = await hydra.owner({
      args: [
        'task',
        'show',
        card.id,
        '--full',
      ],
    })
    expect(afterReminder.task.status).toEqual(beforeReminder.task.status)
    const updates = await hydra.owner({
      args: [
        'task',
        'updates',
        'questions',
      ],
    })
    expect(JSON.stringify(updates)).toContain('task.reminder-due')
    const history = readEvents({ hydraId: hydra.id })
    const dueIndex = history.findIndex(event => event.type === 'task.reminder-due' && event.cardId === card.id)
    const dueEvent = history[dueIndex]

    if (dueEvent?.type !== 'task.reminder-due') {
      throw new Error('Expected a reminder receipt')
    }

    let legacy = replay({
      state: emptyHydra(),
      events: history.slice(
        0,
        dueIndex,
      ),
    })
    const scheduled = legacy.cards[card.id]?.reminder

    if (!scheduled) {
      throw new Error('Expected a scheduled reminder before its receipt')
    }

    scheduled.repeat = {
      everyMs: 60_000,
      until: 'task-done',
    }
    legacy = reduce({
      state: legacy,
      event: {
        ...dueEvent,
        data: {
          ...dueEvent.data,
          column: 'in_progress',
        },
      },
    })
    const legacyReminder = legacy.cards[card.id]?.reminder

    if (!legacyReminder) {
      throw new Error('Expected a recurring reminder after its legacy receipt')
    }

    const withLaterStatus = structuredClone(legacy)
    delete legacyReminder.declaration
    legacy = reduce({
      state: legacy,
      event: {
        ...dueEvent,
        seq: legacy.seq + 1,
        id: 'modern-repeat',
      },
    })
    legacy = reduce({
      state: legacy,
      event: {
        ...dueEvent,
        seq: legacy.seq + 1,
        id: 'clear-repeat',
        type: 'task.reminder',
        data: {
          before: due,
          after: null,
        },
      },
    })
    expect(legacy.cards[card.id]?.status).toEqual(beforeReminder.task.status)

    const workerStatus = {
      ...beforeReminder.task.status,
      id: 'later-worker-status',
      state: 'working' as const,
    }
    const laterCard = withLaterStatus.cards[card.id]

    if (!laterCard) {
      throw new Error('Expected the task with the recurring reminder')
    }

    laterCard.status = workerStatus
    const repeatedWithLaterStatus = reduce({
      state: withLaterStatus,
      event: {
        ...dueEvent,
        seq: withLaterStatus.seq + 1,
        id: 'worker-repeat',
      },
    })
    const clearedWithLaterStatus = reduce({
      state: repeatedWithLaterStatus,
      event: {
        ...dueEvent,
        seq: repeatedWithLaterStatus.seq + 1,
        id: 'clear-worker-repeat',
        type: 'task.reminder',
        data: {
          before: due,
          after: null,
        },
      },
    })
    expect(clearedWithLaterStatus.cards[card.id]?.status).toEqual(workerStatus)

    const asked = await asHydra.run({
      args: [
        'task',
        'ask',
        'questions',
        '--to',
        'owner',
        ...fields.flat(),
        '--reason',
        'Accounting decision',
      ],
    })
    expect((await hydra.task({ key: 'questions' })).column).toBe(await hydra.column({ role: 'needs_you' }))
    await hydra.owner({
      args: [
        'task',
        'answer',
        'questions',
        asked.ask,
        '--choice',
        '1',
      ],
    })
    expect((await hydra.task({ key: 'questions' })).column).toBe(inProgress)
    const workerAsk = await hydra.as({ session: worker }).run({
      args: [
        'task',
        'ask',
        'questions',
        '--question',
        'Which export?',
        '--choice',
        'CSV',
        '--choice',
        'JSON',
        '--recommend',
        '2',
      ],
    })
    expect((await hydra.owner({
      args: [
        'task',
        'questions',
      ],
    })).count).toBe(0)
    expect(rows<{ summary: { asks: number } }>({
      text: 'select summary from hydras where id = $1',
      values: [hydra.id],
    })[0]?.summary.asks).toBe(0)
    expect((await asHydra.refused({
      args: [
        'task',
        'escalate',
        'questions',
        workerAsk.ask,
        '--reason',
        'Accounting decision',
      ],
    })).code).toBe('VALIDATION_ERROR')
    expect((await asHydra.refused({
      args: [
        'task',
        'escalate',
        'questions',
        workerAsk.ask,
        ...fields.slice(
          0,
          3,
        ).flat(),
        '--reason',
        'Accounting decision',
      ],
    })).code).toBe('VALIDATION_ERROR')
    await asHydra.run({
      args: [
        'task',
        'escalate',
        'questions',
        workerAsk.ask,
        ...fields.flat(),
        '--reason',
        'Accounting decision',
      ],
    })
    expect((await hydra.task({ key: 'questions' })).column).toBe(await hydra.column({ role: 'needs_you' }))
    const escalated = await hydra.owner({
      args: [
        'task',
        'show',
        'questions',
        '--full',
      ],
    })
    const question = escalated.task.asks.find((ask: { id: string }) => ask.id === workerAsk.ask)
    expect(question.options.map((option: { label: string }) => option.label)).toEqual([
      'Only open',
      'Include archived',
    ])
    expect(question.recommended).toBe(1)
  },
)

test(
  'related owner questions form one group, share choices safely and answer once',
  async () => {
    const hydra = await pnyx.hydra()
    const project = hydra.folder({ name: 'exports' })
    await hydra.owner({
      args: [
        'project',
        'add',
        project,
      ],
    })
    const parent = await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'Export batch',
      ],
    })

    for (const key of [
      'invoices',
      'payments',
    ]) {
      await hydra.owner({
        args: [
          'task',
          'create',
          '--title',
          key,
          '--key',
          key,
          '--project',
          project,
          '--parent',
          parent.card.id,
        ],
      })
    }

    const session = await hydra.chat({ text: 'Review the batch scope' })
    const asHydra = hydra.as({ session })

    const ask = async ({
      key,
      options = [
        'Open only',
        'Include archived',
      ],
    }: {
      key: string
      options?: string[]
    }) => {
      const card = await hydra.task({ key })

      return asHydra.run({
        args: [
          'task',
          'ask',
          key,
          '--to',
          'owner',
          '--question',
          `Include archived ${key}?`,
          '--context',
          `Archived records change totals. I will build this export after your answer. [${key}](pnyx-task:${card.id})`,
          ...options.flatMap(choice => [
            '--choice',
            choice,
          ]),
          '--recommend',
          '1',
          '--reason',
          'Accounting scope',
        ],
      })
    }

    const first = await ask({ key: 'invoices' })
    const second = await ask({ key: 'payments' })
    const grouped = await hydra.owner({
      args: [
        'task',
        'questions',
      ],
    })
    expect(grouped.count).toBe(1)
    expect(grouped.groups[0]).toMatchObject({
      task: parent.card.id,
      count: 2,
      choices: [
        'Open only',
        'Include archived',
      ],
    })
    expect(rows<{
      summary: {
        asks: number
        projects: {
          name: string
          asks: number
        }[]
      }
    }>({
      text: 'select summary from hydras where id = $1',
      values: [hydra.id],
    })[0]?.summary).toMatchObject({
      asks: 1,
      projects: expect.arrayContaining([
        expect.objectContaining({
          name: 'exports',
          asks: 1,
        }),
      ]),
    })
    const keys = grouped.groups[0].questions.map((question: { key: string }) => question.key)
    const snapshot = JSON.stringify(keys)
    const answer = [
      'task',
      'answer-group',
      parent.card.id,
      '--questions',
      snapshot,
      '--choice',
      'Open only',
      '--event-id',
      'batch-open-only',
    ]
    expect((await asHydra.refused({ args: answer })).code).toBe('OWNER_ONLY')
    const malformedSnapshot = JSON.stringify([
      ...keys,
      'not-a-question-key',
    ])
    const malformedAnswer = answer.map(value => value === snapshot ? malformedSnapshot : value)
    expect((await hydra.ownerRefused({ args: malformedAnswer })).code).toBe('VALIDATION_ERROR')
    const numericChoice = answer.map((
      value,
      index,
    ) => answer[index - 1] === '--choice' ? '1' : value)
    expect((await hydra.ownerRefused({ args: numericChoice })).code).toBe('VALIDATION_ERROR')
    await hydra.owner({ args: answer })
    const repeated = await hydra.owner({ args: answer })
    expect(repeated.answers.every((receipt: { repeat?: boolean }) => receipt.repeat)).toBe(true)
    const differentRetry = answer.map((
      value,
      index,
    ) => answer[index - 1] === '--choice' ? 'Include archived' : value)
    expect((await hydra.ownerRefused({ args: differentRetry })).code).toBe('CONFLICT')
    expect((await hydra.owner({
      args: [
        'task',
        'questions',
      ],
    })).count).toBe(0)

    for (const [
      key,
      asked,
    ] of [
        [
          'invoices',
          first,
        ],
        [
          'payments',
          second,
        ],
      ] as const) {
      const card = await hydra.owner({
        args: [
          'task',
          'show',
          key,
          '--full',
        ],
      })
      expect(card.task.asks.find((ask: { id: string }) => ask.id === asked.ask)).toMatchObject({ choice: 'Open only' })
    }

    const third = await ask({ key: 'invoices' })
    const old = await hydra.owner({
      args: [
        'task',
        'questions',
      ],
    })
    await ask({
      key: 'payments',
      options: [
        'Open only: Include the current billing period only',
        'Everything',
      ],
    })
    const recovered = await hydra.owner({ args: answer })
    expect(recovered.answers).toMatchObject([
      { repeat: true },
      { repeat: true },
    ])
    const oldKeys = old.groups[0].questions.map((question: { key: string }) => question.key)
    const stale = JSON.stringify(oldKeys)
    expect((await hydra.ownerRefused({
      args: [
        'task',
        'answer-group',
        parent.card.id,
        '--questions',
        stale,
        '--choice',
        'Open only',
        '--event-id',
        'stale-batch',
      ],
    })).code).toBe('CONFLICT')
    const different = await hydra.owner({
      args: [
        'task',
        'questions',
      ],
    })
    expect(different.groups[0].choices).toEqual([])
    const currentKeys = different.groups[0].questions.map(
      (question: { key: string }) => question.key,
    )
    const current = JSON.stringify(currentKeys)
    expect((await hydra.ownerRefused({
      args: [
        'task',
        'answer-group',
        parent.card.id,
        '--questions',
        current,
        '--choice',
        'Open only',
        '--event-id',
        'different-batch',
      ],
    })).code).toBe('VALIDATION_ERROR')
    const unchanged = await hydra.owner({
      args: [
        'task',
        'show',
        'invoices',
        '--full',
      ],
    })
    const unanswered = unchanged.task.asks.find((ask: { id: string }) => ask.id === third.ask)
    expect(unanswered.answered).toBeUndefined()
  },
)

test(
  'group delivery stops when a new question arrives between worker sends',
  async () => {
    const hydra = await pnyx.hydra()
    const parent = await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'Export delivery batch',
      ],
    })
    const session = await hydra.chat({ text: 'Coordinate worker decisions' })
    const asHydra = hydra.as({ session })
    const gate = hydra.folder({ name: 'delivery-gate' })
    const bin = hydra.folder({ name: 'delivery-bin' })
    const originalPath = process.env.PATH
    const tmux = join(
      bin,
      'tmux',
    )
    writeFileSync(
      tmux,
      `#!${process.execPath}\n${readFileSync(
        join(
          import.meta.dirname,
          'setup/fixtures/tmux-gate.mjs',
        ),
        'utf8',
      )}`,
    )
    chmodSync(
      tmux,
      0o755,
    )
    writeFileSync(
      join(
        bin,
        'ps',
      ),
      '#!/bin/sh\nprintf "ttys123\\n"\n',
      { mode: 0o755 },
    )
    const asks = new Map<string, string>()

    for (const key of [
      'first',
      'second',
    ]) {
      await hydra.owner({
        args: [
          'task',
          'create',
          '--title',
          key,
          '--key',
          key,
          '--parent',
          parent.card.id,
        ],
      })
      await hydra.owner({
        args: [
          'push',
          '--key',
          key,
          '--file',
          '-',
        ],
        input: JSON.stringify({
          agent: {
            provider: 'codex',
            sessionId: `outside-${key}`,
          },
          activity: 'finished',
          terminal: {
            tmux: gate,
            tmuxPane: key === 'first' ? '%1' : '%2',
            tty: '/dev/ttys123',
            pid: '123',
          },
        }),
      })
      const card = await hydra.task({ key })
      const asked = await hydra.owner({
        args: [
          'task',
          'ask',
          key,
          '--actor',
          `worker:${card.id}`,
          '--question',
          'Include archived records?',
          '--context',
          `Archived records change totals. I will build after your choice. [Export](pnyx-task:${card.id})`,
          '--choice',
          'Open only',
          '--choice',
          'Include archived',
          '--recommend',
          '1',
        ],
      })
      asks.set(
        key,
        asked.ask,
      )
      await asHydra.run({
        args: [
          'task',
          'escalate',
          key,
          asked.ask,
          '--reason',
          'Accounting scope',
        ],
      })
    }

    const grouped = await hydra.owner({
      args: [
        'task',
        'questions',
      ],
    })
    const questions = grouped.groups[0].questions as { key: string }[]
    const firstId = decodeURIComponent(questions[0].key.split('/')[0])
    const firstKey = (await hydra.task({ key: 'first' })).id === firstId ? 'first' : 'second'
    process.env.PATH = `${bin}:${originalPath}`
    const attempt = [
      'task',
      'answer-group',
      parent.card.id,
      '--questions',
      JSON.stringify(questions.map(question => question.key)),
      '--choice',
      'Open only',
      '--event-id',
      'gated-delivery',
    ]
    const answer = hydra.ownerRefused({ args: attempt }).then(
      result => ({ result }),
      error => ({ error }),
    )
    let arrived: string | undefined

    try {
      await until({
        what: 'the terminal receives its gated answer',
        check: () => existsSync(join(
          gate,
          'received',
        )),
      })
      const added = await asHydra.run({
        args: [
          'task',
          'ask',
          parent.card.id,
          '--to',
          'owner',
          '--question',
          'Include draft records?',
          '--context',
          `Drafts change totals. I will build after your choice. [Batch](pnyx-task:${parent.card.id})`,
          '--choice',
          'Open only',
          '--choice',
          'Include archived',
          '--recommend',
          '1',
          '--reason',
          'New accounting scope',
        ],
      })
      arrived = added.ask
    } finally {
      writeFileSync(
        join(
          gate,
          'release',
        ),
        '',
      )
      await answer.finally(() => {
        process.env.PATH = originalPath
      })
    }

    expect(await answer).toHaveProperty(
      'result.code',
      'CONFLICT',
    )

    for (const key of [
      'first',
      'second',
    ]) {
      const shown = await hydra.owner({
        args: [
          'task',
          'show',
          key,
          '--full',
        ],
      })
      const ask = shown.task.asks.find((ask: { id: string }) => ask.id === asks.get(key))

      if (key === firstKey) {
        expect(ask.choice).toBe('Open only')
        expect(shown.task.replies).toEqual(expect.arrayContaining([
          expect.objectContaining({
            state: 'delivered',
            decision: expect.objectContaining({ choice: 'Open only' }),
          }),
        ]))
      } else {
        expect(ask.answered).toBeUndefined()
        expect(shown.task.replies ?? []).toHaveLength(0)
      }
    }

    const remaining = await hydra.owner({
      args: [
        'task',
        'questions',
      ],
    })
    expect(remaining.groups[0].count).toBe(2)
    await hydra.owner({
      args: [
        'task',
        'answer',
        parent.card.id,
        arrived!,
        '--choice',
        '1',
      ],
    })
    const fail = join(
      gate,
      'fail',
    )
    writeFileSync(
      fail,
      '',
    )
    process.env.PATH = `${bin}:${originalPath}`

    try {
      const failed = await hydra.owner({ args: attempt })
      expect(failed.answers).toMatchObject([
        { repeat: true },
        { state: 'failed' },
      ])
      expect(readFileSync(
        join(
          gate,
          'sent',
        ),
        'utf8',
      ).trim()
        .split('\n')).toHaveLength(1)
      unlinkSync(fail)
      const failedQuestionWithDifferentChoice = attempt.map((
        value,
        index,
      ) => {
        const flag = attempt[index - 1]

        return flag === '--choice' ? 'Include archived' : value
      })
      expect((await hydra.ownerRefused({ args: failedQuestionWithDifferentChoice })).code).toBe('CONFLICT')
      expect(readFileSync(
        join(
          gate,
          'sent',
        ),
        'utf8',
      ).trim()
        .split('\n')).toHaveLength(1)
      const recovered = await hydra.owner({ args: attempt })
      expect(recovered.answers).toMatchObject([
        { repeat: true },
        { state: 'delivered' },
      ])
    } finally {
      process.env.PATH = originalPath
    }

    expect(readFileSync(
      join(
        gate,
        'sent',
      ),
      'utf8',
    ).trim()
      .split('\n')
      .sort()).toEqual([
      '%1',
      '%2',
    ])

    for (const key of [
      'first',
      'second',
    ]) {
      const shown = await hydra.owner({
        args: [
          'task',
          'show',
          key,
          '--full',
        ],
      })
      expect(shown.task.replies).toHaveLength(1)
      expect(shown.task.replies[0].state).toBe('delivered')
      expect(shown.task.asks[0].choice).toBe('Open only')
    }

    expect((await hydra.owner({
      args: [
        'task',
        'questions',
      ],
    })).count).toBe(0)
  },
)

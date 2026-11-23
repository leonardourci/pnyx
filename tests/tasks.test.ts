import { withWriter } from '#app/writer.ts'
import { loadHydra } from '#app/store.ts'
import { workerLine } from './setup/worker-log.ts'
import { fireReminders } from '#tasks/fire-reminders.ts'
import { emptyHydra, reduce, replay } from '#app/reducer.ts'
import { readChanges, readEvents } from '#app/event-log.ts'
import { eventReasons } from '#hydra/wake-reasons.ts'
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
// TypeScript cannot rewrite the web alias's .ts extension when checking this test.
import { pageTitle } from '../web/src/app/view.ts'
import { beforeAll, expect, test } from 'vitest'
import { operation, startPnyx, until, type Pnyx } from './setup/pnyx.ts'

let pnyx: Pnyx

beforeAll(async () => {
  pnyx = await startPnyx()
})

test(
  'a task uses factual state as its worker and Hydra report, a second start steers its worker unless a start flag is invalid, and its dependent becomes ready once it is done',
  async () => {
    const hydra = await pnyx.hydra()
    const folder = hydra.folder({ name: 'export' })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--no-start',
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
        '--no-start',
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

    expect((await hydra.ownerRefused({
      args: [
        'task',
        'start',
        'build',
        '--via',
        'nowhere',
        '--prompt',
        'Export the archive too',
      ],
    })).code).toBe('VALIDATION_ERROR')

    const again = await hydra.owner({
      args: [
        'task',
        'start',
        'build',
        '--model',
        'opus',
        '--prompt',
        'Also export the refunds',
      ],
    })
    expect(again).toMatchObject({
      launch: 'steered',
      worker: (await hydra.task({ key: 'build' })).worker,
      unapplied: ['--account, --model, --effort, --mode or --fast'],
    })
    await until({
      what: 'the worker to hear the start prompt',
      check: () => worker.received.some(text => text.includes('Also export the refunds')),
    })
    expect(worker.received.some(text => text.includes('Export the archive too'))).toBe(false)
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

    await workerLine({
      hydra,
      key: 'build',
      line: 'done: export written',
    })
    const completedState = loadHydra({ hydraId: hydra.id }).state
    const completedEvent = readChanges({
      hydraId: hydra.id,
      types: ['task.worker-line'],
    }).at(-1)!
    expect(eventReasons({
      state: completedState,
      event: completedEvent,
    })).toContainEqual({
      kind: 'prerequisite',
      card: (await hydra.task({ key: 'ship' })).id,
      detail: 'prerequisites cleared; ready for dispatch',
    })

    await hydra.owner({
      args: [
        'outcome',
        'build',
        'done',
        '--note',
        'Export written',
      ],
    })
    expect(await hydra.task({ key: 'build' })).toMatchObject({
      status: 'done',
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
          '--no-start',
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
  'a start on a held task goes ahead and lists the hold, with the command that releases it, once on the card, and a failed or retried start adds nothing',
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
    const card = await hydra.task({ key: 'rename' })
    const notes = async () => (await hydra.owner({
      args: [
        'task',
        'show',
        'rename',
        '--full',
      ],
    })).task.notes

    expect((await hydra.ownerRefused({
      args: [
        'task',
        'start',
        'rename',
        '--via',
        'nowhere',
      ],
    })).code).toBe('VALIDATION_ERROR')
    expect(await notes()).toBeUndefined()

    const start = [
      'task',
      'start',
      'rename',
      '--prompt',
      'Rename the public API',
      '--event-id',
      'rename-start',
    ]
    const started = await hydra.owner({ args: start })
    expect(started.open).toEqual([
      expect.objectContaining({
        reason: 'held for discussion: Rename the API',
        clear: expect.stringContaining(`task ${card.id} in the UI`),
      }),
    ])
    const worker = await hydra.agent({ cwd: folder })
    expect(worker.received).toHaveLength(1)

    expect(await hydra.owner({ args: start })).toMatchObject({ event: 'none: duplicate' })
    expect(worker.received).toHaveLength(1)
    expect(await notes()).toEqual([expect.objectContaining({ source: 'pnyx:start' })])
  },
)

test(
  'a hold releases with an older or agent message, with a notice, and an owner go message releases it without a notice',
  async () => {
    const hydra = await pnyx.hydra()
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
      undefined,
    ]) {
      const source = message ?? (await hydra.owner({
        args: [
          'hydra',
          'send',
          '--text',
          'Proceed with the rename',
        ],
      })).message
      const go = await hydra.owner({
        args: [
          'task',
          'ask',
          'still-held',
          '--to',
          'owner',
          '--kind',
          'go',
          '--question',
          'Proceed with the rename?',
        ],
      })
      const released = await hydra.owner({
        args: [
          'task',
          'release',
          'still-held',
          '--from-message',
          source,
          '--reason',
          'Released',
        ],
      })
      expect(released.notices).toBeDefined()
      const releasedTask = (await hydra.owner({
        args: [
          'task',
          'show',
          'still-held',
          '--full',
        ],
      })).task
      const answeredGo = releasedTask.asks.find((ask: { id: string }) => ask.id === go.ask)
      expect(answeredGo.choice).toBe('Go')
      expect(answeredGo.fromMessage ?? null).toBeNull()
      expect((await hydra.task({ key: 'still-held' })).hold).toBeUndefined()
      expect((await hydra.ownerRefused({
        args: [
          'task',
          'release',
          'still-held',
          '--from-message',
          'missing-release-message',
        ],
      })).code).toBe('NOT_FOUND')
      await hydra.owner({
        args: [
          'task',
          'hold',
          'still-held',
          '--reason',
          'Discuss the rename',
        ],
      })
    }

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
        'still-held',
        '--from-message',
        go.message,
        '--reason',
        'The owner said go',
      ],
    })
    expect((await hydra.task({ key: 'still-held' })).hold).toBeUndefined()
  },
)

test(
  'a create files the owner ask and brief and starts its worker in one call, a replay starts nothing more, a task left unstarted shows why or that no reason was given, one set to wait on Hydra itself files nothing, and a start cannot steer Hydra itself',
  async () => {
    const hydra = await pnyx.hydra()
    const folder = hydra.folder({ name: 'ring' })
    const sent = await hydra.owner({
      args: [
        'hydra',
        'send',
        '--text',
        'Please fix the usage ring, it is not accurate',
      ],
    })
    const create = [
      'task',
      'create',
      '--title',
      'Fix the usage ring',
      '--folder',
      folder,
      '--ask',
      'fix the usage ring',
      '--message',
      sent.message,
      '--brief',
      'Show the usage the agent reports',
      '--actor',
      'hydra',
      '--reason',
      'The owner asked for the fix',
      '--if-revision',
      '0',
      '--event-id',
      'ring-create',
    ]
    const first = await hydra.owner({ args: create })
    expect(first).toMatchObject({
      launch: 'started',
      rule: 'default',
      agent: {
        harness: 'claude',
        host: 'pnyx',
      },
    })
    const worker = await hydra.agent({ cwd: folder })
    expect(worker.received).toHaveLength(1)
    expect(worker.received[0]).toContain('fix the usage ring')
    expect(worker.received[0]).toContain('Show the usage the agent reports')
    expect((await hydra.task({ key: first.card.id })).worker).toBe(first.worker)

    await hydra.owner({
      args: [
        'task',
        'hold',
        first.card.id,
        '--reason',
        'Review the description before resuming',
      ],
    })
    const changedBrief = [
      'task',
      'brief',
      first.card.id,
      '--brief',
      'Show the usage and its context window',
      '--event-id',
      'ring-description',
    ]
    await hydra.owner({ args: changedBrief })
    await hydra.owner({ args: changedBrief })
    await hydra.owner({
      args: [
        'task',
        'brief',
        first.card.id,
        '--brief',
        '',
      ],
    })
    const inbox = await hydra.owner({
      args: [
        'task',
        'inbox',
        'read',
        first.card.id,
        '--all',
      ],
    })
    expect(inbox.messages.filter((message: { text: string }) => message.text.includes('Description updated:'))).toHaveLength(2)
    expect(worker.received.some(text => text.includes('Description updated:'))).toBe(false)
    await hydra.owner({
      args: [
        'task',
        'release',
        first.card.id,
      ],
    })
    await until({
      what: 'both held description edits reaching the existing worker',
      check: () => worker.received.some(text => text.includes('Description updated:\n\nShow the usage and its context window'))
        && worker.received.some(text => text.includes('Description updated:\n\n(Description cleared.)')),
    })
    const instructions = worker.received.join('\n')
    expect(instructions.match(/Description updated:/g)).toHaveLength(2)
    expect(instructions.indexOf('Description updated:\n\nShow the usage and its context window'))
      .toBeLessThan(instructions.indexOf('Description updated:\n\n(Description cleared.)'))

    await hydra.as({ session: worker }).run({
      args: [
        'task',
        'ask',
        first.card.id,
        '--question',
        'Which ring do you mean?',
      ],
    })
    expect(await hydra.owner({ args: create })).toMatchObject({
      launch: 'started',
      worker: first.worker,
    })
    expect(pnyx.claude.sessions.filter(session => session.cwd === folder)).toEqual([worker])

    const later = await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'Polish the usage ring',
        '--no-start',
        '--actor',
        'hydra',
        '--reason',
        'The owner wants the fix to land first',
      ],
    })
    expect(later).toMatchObject({
      launch: 'not started',
      reason: 'The owner wants the fix to land first',
    })
    expect((await hydra.task({ key: later.card.id })).worker).toBe('none: not started: The owner wants the fix to land first')

    const saved = await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'Redraw the usage ring',
        '--no-start',
      ],
    })
    expect((await hydra.task({ key: saved.card.id })).worker).toBe('none: not started, no reason given')

    const session = await hydra.chat({ text: 'Also add a legend to the usage ring' })
    expect((await operation({
      args: [
        'apply',
        '--file',
        '-',
        '--hydra',
        hydra.id,
      ],
      env: session.env,
      input: JSON.stringify({
        version: 1,
        changes: [
          {
            op: 'task.create',
            key: 'legend',
            title: 'Add a legend to the usage ring',
            reason: 'The owner asked for a legend',
          },
        ],
      }),
    })).status).toBe(0)
    expect((await hydra.task({ key: 'legend' })).worker).toBe('none: not started, no reason given')

    expect((await hydra.ownerRefused({
      args: [
        'task',
        'create',
        '--title',
        'Wait for Hydra',
        '--on',
        '$hydra',
      ],
    })).code).toBe('VALIDATION_ERROR')
    expect((await hydra.owner({
      args: [
        'task',
        'list',
      ],
    })).tasks.some((task: { title: string }) => task.title === 'Wait for Hydra')).toBe(false)

    expect((await hydra.ownerRefused({
      args: [
        'task',
        'start',
        '$hydra',
        '--prompt',
        'Drop the legend',
      ],
    })).code).toBe('NOT_FOUND')
  },
)

test(
  'a create behind a worker it cannot share starts its own worker and says why it was not queued, one with an unknown target, an unknown start route or both --start and --no-start files nothing, a queue or reorder that cannot happen explains instead of refusing, and the Hydra card cannot queue',
  async () => {
    const hydra = await pnyx.hydra()
    const { folder } = await hydra.startTask({ key: 'export' })
    const importFolder = hydra.folder({ name: 'import' })
    const behind = await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'Build the import',
        '--folder',
        importFolder,
        '--brief',
        'Read the exported CSV back',
        '--behind',
        'export',
      ],
    })
    expect(behind).toMatchObject({
      launch: 'started',
      queued: expect.stringContaining('is in Ideas'),
    })
    expect(behind.help.join('\n')).toContain('task.log session records')
    expect((await hydra.agent({ cwd: importFolder })).received[0]).toContain('Read the exported CSV back')
    expect(pnyx.claude.sessions.filter(session => session.cwd === folder)).toHaveLength(1)

    const refusals = [
      {
        flags: [
          '--behind',
          'no-such-task',
        ],
        code: 'NOT_FOUND',
      },
      {
        flags: [
          '--via',
          'nowhere',
        ],
        code: 'VALIDATION_ERROR',
      },
      {
        flags: [
          '--start',
          '--harness',
          'claude',
          '--no-start',
        ],
        code: 'VALIDATION_ERROR',
      },
      {
        flags: [
          '--start',
          '--harness',
          'claude',
          '--hold',
        ],
        code: 'VALIDATION_ERROR',
      },
    ]

    for (const {
      flags,
      code,
    } of refusals) {
      expect((await hydra.ownerRefused({
        args: [
          'task',
          'create',
          '--title',
          'Import the refunds',
          ...flags,
        ],
      })).code).toBe(code)
    }

    expect((await hydra.owner({
      args: [
        'task',
        'list',
      ],
    })).tasks.some((task: { title: string }) => task.title === 'Import the refunds')).toBe(false)

    const idea = await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'Archive the export',
        '--no-start',
      ],
    })
    const later = await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'Compress the archive',
        '--no-start',
      ],
    })
    const answers = [
      {
        action: 'queue',
        anchor: 'export',
        reason: 'worker’s project',
      },
      {
        action: 'queue',
        anchor: later.card.id,
        reason: 'no live task worker',
      },
      {
        action: 'reorder',
        anchor: 'export',
        reason: 'is not queued',
      },
    ]

    for (const {
      action,
      anchor,
      reason,
    } of answers) {
      expect(await hydra.owner({
        args: [
          'task',
          action,
          idea.card.id,
          '--behind',
          anchor,
        ],
      })).toMatchObject({
        queued: false,
        reason: expect.stringContaining(reason),
      })
    }

    expect((await hydra.task({ key: idea.card.id })).queue).toBeUndefined()
    expect((await hydra.ownerRefused({
      args: [
        'task',
        'queue',
        '$hydra',
        '--behind',
        'export',
      ],
    })).code).toBe('VALIDATION_ERROR')
  },
)

test(
  'Hydra holds work for the owner, a held or dependent create stays unstarted with its reason, and a start on the dependent goes ahead and lists the dependency',
  async () => {
    const hydra = await pnyx.hydra()
    const folder = hydra.folder({ name: 'talk-first' })
    const docsFolder = hydra.folder({ name: 'rename-docs' })
    const sent = await hydra.owner({
      args: [
        'hydra',
        'send',
        '--text',
        'Let us talk about renaming the API before anyone builds it, and document it after',
      ],
    })
    const held = await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'Rename the API',
        '--folder',
        folder,
        '--ask',
        'talk about renaming the API before anyone builds it',
        '--message',
        sent.message,
        '--brief',
        'Rename the public API',
        '--hold',
        '--actor',
        'hydra',
        '--reason',
        'The owner wants to talk first',
        '--event-id',
        'rename-held',
      ],
    })
    expect(held).toMatchObject({
      launch: 'held',
      hold: 'The owner wants to talk first',
    })
    expect(pnyx.claude.sessions.some(session => session.cwd === folder)).toBe(false)
    const questionPage = await hydra.page()
    const goQuestion = await questionPage.send({
      name: 'task',
      args: [
        'ask',
        held.card.id,
        '--to',
        'owner',
        '--kind',
        'go',
        '--question',
        'Rename the API now?',
        '--context',
        `Go starts the rename. [Card](pnyx-task:${encodeURIComponent(held.card.id)})`,
        '--actor',
        'hydra',
        '--reason',
        'The owner wants to talk first',
      ],
    })
    questionPage.close()
    expect(goQuestion).toMatchObject({ ask: expect.any(String) })

    const waiting = await hydra.owner({
      args: [
        'task',
        'create',
        '--title',
        'Document the rename',
        '--folder',
        docsFolder,
        '--ask',
        'document it after',
        '--message',
        sent.message,
        '--brief',
        'Update the API docs',
        '--on',
        held.card.id,
        '--actor',
        'hydra',
        '--reason',
        'The docs follow the rename',
        '--event-id',
        'rename-docs',
      ],
    })
    expect(waiting).toMatchObject({
      launch: 'waiting',
      on: [held.card.id],
    })
    expect(pnyx.claude.sessions.some(session => session.cwd === docsFolder)).toBe(false)

    const docs = await hydra.owner({
      args: [
        'task',
        'start',
        waiting.card.id,
      ],
    })
    expect(docs.open).toEqual([
      expect.objectContaining({
        clear: expect.stringContaining(held.card.id),
      }),
    ])
    expect((await hydra.agent({ cwd: docsFolder })).received).toHaveLength(1)
  },
)

test(
  'a start with an open question goes ahead and lists it with the command that answers it, and a create that cannot start notes why once however often it is retried',
  async () => {
    const hydra = await pnyx.hydra()
    const folder = hydra.folder({ name: 'archive' })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Archive invoices',
        '--key',
        'archive',
        '--folder',
        folder,
        '--brief',
        'Archive the old invoices',
      ],
    })
    const card = await hydra.task({ key: 'archive' })
    const asked = await hydra.owner({
      args: [
        'task',
        'ask',
        'archive',
        '--to',
        'owner',
        '--question',
        'Archive paid invoices too?',
        '--context',
        `Paid invoices leave the totals. After your choice I will start the archive. [Archive](pnyx-task:${card.id})`,
        '--choice',
        'Only unpaid',
        '--choice',
        'Paid too',
        '--recommend',
        '1',
        '--actor',
        'hydra',
        '--reason',
        'Only the owner knows the rule',
      ],
    })

    const started = await hydra.owner({
      args: [
        'task',
        'start',
        'archive',
      ],
    })
    expect(started.open).toEqual([
      expect.objectContaining({
        reason: expect.stringContaining(asked.ask),
        clear: expect.stringContaining(`pnyx answer ${card.id} ${asked.ask}`),
      }),
    ])
    expect((await hydra.agent({ cwd: folder })).received[0]).toContain('Archive the old invoices')

    const idea = [
      'task',
      'create',
      '--title',
      'Sketch the invoice archive',
      '--actor',
      'hydra',
      '--reason',
      'The owner asked for a sketch',
      '--event-id',
      'archive-sketch',
    ]

    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await hydra.owner({ args: idea })).toMatchObject({ launch: 'not started' })
    }

    const sketch = (await hydra.owner({
      args: [
        'task',
        'list',
      ],
    })).tasks.find((task: { title: string }) => task.title === 'Sketch the invoice archive')
    expect((await hydra.owner({
      args: [
        'task',
        'show',
        sketch.id,
        '--full',
      ],
    })).task.notes).toEqual([expect.objectContaining({ source: 'pnyx:create' })])
  },
)

test(
  'arrangement can be undone and apply --check previews task creation without writing',
  async () => {
    const hydra = await pnyx.hydra()
    await hydra.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Later work',
        '--key',
        'later',
      ],
    })

    const first = await hydra.owner({
      args: [
        'task',
        'create',
        '--key',
        'first-in-ideas',
        '--title',
        'First in Ideas',
      ],
    })
    const arranged = await hydra.owner({
      args: [
        'task',
        'arrange',
        first.card.id,
        '--before',
        'later',
      ],
    })
    expect((await hydra.ownerRefused({
      args: [
        'task',
        'rename',
        first.card.id,
        '--title',
        'Renamed',
        '--event-id',
        arranged.event.id,
      ],
    })).code).toBe('IDEMPOTENCY_CONFLICT')
    const { task: placed } = await hydra.owner({
      args: [
        'task',
        'show',
        first.card.id,
        '--full',
      ],
    })
    const { task: later } = await hydra.owner({
      args: [
        'task',
        'show',
        'later',
        '--full',
      ],
    })
    expect(placed.rank).toBeLessThan(later.rank ?? later.createdSeq)
    await hydra.owner({
      args: [
        'undo',
        arranged.event.id,
      ],
    })
    const { task: restored } = await hydra.owner({
      args: [
        'task',
        'show',
        first.card.id,
        '--full',
      ],
    })
    expect(restored.rank ?? restored.createdSeq).toBeGreaterThan(later.rank ?? later.createdSeq)

    const earlierArrangement = await hydra.owner({
      args: [
        'task',
        'arrange',
        first.card.id,
        '--before',
        'later',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'arrange',
        first.card.id,
      ],
    })
    expect((await hydra.ownerRefused({
      args: [
        'undo',
        earlierArrangement.event.id,
      ],
    })).code).toBe('CONFLICT')

    await hydra.owner({
      args: [
        'task',
        'create',
        '--key',
        'created-before',
        '--title',
        'Created before Later',
        '--before',
        'later',
      ],
    })
    const { task: createdBefore } = await hydra.owner({
      args: [
        'task',
        'show',
        'created-before',
        '--full',
      ],
    })
    expect(createdBefore.rank).toBeLessThan(later.rank ?? later.createdSeq)

    const seq = () => loadHydra({ hydraId: hydra.id }).state.seq
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
        '--no-start',
        '--title',
        'Export',
      ],
    })
    const other = await hydra.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'Import',
      ],
    })
    const child = await hydra.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--title',
        'CSV',
      ],
    })
    const leaf = await hydra.owner({
      args: [
        'task',
        'create',
        '--no-start',
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

    const retention = async () => {
      const { task } = await hydra.owner({
        args: [
          'task',
          'show',
          'family',
          '--full',
        ],
      })

      return {
        doneAt: task.doneAt ?? null,
        hidden: task.hidden ?? false,
      }
    }

    await hydra.owner({
      args: [
        'task',
        'create',
        '--no-start',
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
        '--no-start',
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
        '--no-start',
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
        'outcome',
        'family',
        'done',
        '--note',
        'Parent work completed',
      ],
    })
    expect(await retention()).toEqual({
      doneAt: null,
      hidden: false,
    })
    await hydra.owner({
      args: [
        'outcome',
        'part',
        'done',
        '--note',
        'Child completed',
      ],
    })
    expect(await retention()).toEqual({
      doneAt: null,
      hidden: false,
    })
    await hydra.owner({
      args: [
        'outcome',
        'second-part',
        'done',
        '--note',
        'Validation completed',
      ],
    })
    expect((await retention()).doneAt).toBeTypeOf('string')
    await hydra.owner({
      args: [
        'outcome',
        'part',
        '--clear',
      ],
    })
    expect(await retention()).toEqual({
      doneAt: null,
      hidden: false,
    })
    await pnyx.restart()
    expect(await retention()).toEqual({
      doneAt: null,
      hidden: false,
    })

    await hydra.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--key',
        'earned',
        '--title',
        'Completed outside work',
      ],
    })
    const earned = await workerLine({
      hydra,
      key: 'earned',
      line: 'done: outside work completed',
    })
    expect(earned.doneAt).toBeTypeOf('string')
    const agent = {
      provider: 'claude',
      sessionId: 'retention-earned',
    }
    await hydra.owner({
      args: [
        'push',
        '--key',
        'earned',
        '--file',
        '-',
      ],
      input: JSON.stringify({
        agent,
        activity: 'finished',
      }),
    })
    const retained = await hydra.owner({
      args: [
        'task',
        'show',
        'earned',
        '--full',
      ],
    })
    expect(retained.task.doneAt).toBe(earned.doneAt)
    expect((await hydra.task({ key: 'earned' })).status).toBe('done')
    await hydra.owner({
      args: [
        'push',
        '--key',
        'earned',
        '--file',
        '-',
      ],
      input: JSON.stringify({
        agent,
        activity: 'working',
      }),
    })
    expect((await hydra.owner({
      args: [
        'task',
        'show',
        'earned',
        '--full',
      ],
    })).task.doneAt).toBeUndefined()
    await hydra.owner({
      args: [
        'push',
        '--key',
        'earned',
        '--file',
        '-',
      ],
      input: JSON.stringify({
        agent,
        activity: 'finished',
      }),
    })
    expect((await hydra.task({ key: 'earned' })).status).toBe('idle')
    await hydra.owner({
      args: [
        'task',
        'ask',
        'earned',
        '--to',
        'owner',
        '--question',
        'Approve the delivered export?',
        '--context',
        'The owner must review the exported totals.',
      ],
    })
    const awaitingOwner = await workerLine({
      hydra,
      key: 'earned',
      line: 'done: export ready for owner review',
    })
    expect(awaitingOwner.doneAt).toBeUndefined()
    expect((await hydra.task({ key: 'earned' })).status).toBe('needs you')
  },
)

test(
  'a retried rename answers for its own operation from the task as it is now, and with the task id alone once the task moved to another Hydra',
  async () => {
    const hydra = await pnyx.hydra()
    const other = await pnyx.hydra()
    const created = await hydra.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--key',
        'retried',
        '--title',
        'Retried',
      ],
    })
    const taskId = created.card.id as string
    const declare = [
      'task',
      'rename',
      'retried',
      '--title',
      'First pass',
      '--event-id',
      'retried-declaration',
    ]
    const first = await hydra.owner({ args: declare })
    const later = await hydra.owner({
      args: [
        'task',
        'rename',
        taskId,
        '--title',
        'Waiting on access',
      ],
    })
    expect(later.card.revision).toBeGreaterThan(first.card.revision)

    const retried = await hydra.owner({ args: declare })
    expect(retried.duplicate).toBe('event id already applied; nothing appended')
    expect(retried.event).toEqual(first.event)
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
        '--no-start',
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
        '--no-start',
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
        '--no-start',
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
    await hydra.owner({
      args: [
        'task',
        'arrange',
        'p',
        '--before',
        'a',
        '--event-id',
        'manual:lifecycle',
      ],
    })
    expect(readEvents({ hydraId: hydra.id }).some(event => event.id === 'manual:lifecycle')).toBe(true)
  },
)

test(
  'untracked pushes refuse grandchildren and hook observations remain separate sessions',
  async () => {
    const id = 'unconfigured-depth'

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
      type: 'task.edited',
      at: '2026-11-17T00:00:00Z',
      actor: 'cli',
      ...event,
    })).join('\n')
    await withWriter({
      hydraId: id,
      create: true,
      fn: ({ writer }) => {
        for (const line of events.split('\n')) {
          writer.append({
            event: {
              ...JSON.parse(line),
              seq: writer.state.seq + 1,
            },
          })
        }
      },
    })
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
    await hydra.owner({
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
    })
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

    const path = join(
      process.env.TMPDIR!,
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
        type: 'task.edited',
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
    await withWriter({
      hydraId: id,
      create: true,
      fn: ({ writer }) => {
        for (const line of events.split('\n')) {
          writer.append({
            event: {
              ...JSON.parse(line),
              seq: writer.state.seq + 1,
            },
          })
        }
      },
    })
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
    expect(await until({
      what: 'the reminder-only Hydra summary',
      check: () => {
        const summary = pnyx.home().hydras.find(summary => summary.id === id)

        if (summary?.projects.length === 1) {
          return summary
        }
      },
    })).toMatchObject({
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
        type: 'task.edited' as const,
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
      '--no-start',
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
  const order = ({ parent }: { parent?: string } = {}) => Object.values(loadHydra({
    hydraId: hydra.id,
  }).state.cards).filter(card => {
    const inParent = (card.parentId ?? null) === (parent ?? null)

    return inParent && entries.some(entry => entry.key === card.key)
  })
    .sort((
      a,
      b,
    ) => (a.rank ?? a.createdSeq) - (b.rank ?? b.createdSeq))
    .map(card => ({ key: card.key }))
    .map(card => card.key)

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

    if (event.type !== 'task.edited') {
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
        '--no-start',
        '--key',
        'other',
        '--title',
        'Other root',
        '--project',
        repository,
      ],
    })
    const snapshot = () => Object.values(loadHydra({
      hydraId: hydra.id,
    }).state.cards).filter(card => card.id === child)
      .map(card => ({
        parent_id: card.parentId ?? null,
        rank: card.rank ?? null,
        updated_seq: card.updatedSeq,
      }))
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
  'owner question presentation defaults carry notices, invalid choices stay invalid, and updates never ask for a decision',
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
    const asWorker = hydra.as({ session: worker })
    const managed = await asHydra.run({
      args: [
        'task',
        'ask',
        'questions',
        '--to',
        'owner',
        '--question',
        'Choose an export format?',
        '--choice',
        'CSV',
        '--choice',
        'JSON',
      ],
    })
    const deferred = await asWorker.run({
      args: [
        'task',
        'defer-question',
        'questions',
        managed.ask,
        '--until',
        '2099-01-01T09:00:00Z',
      ],
    })
    expect(deferred.notices).toBeDefined()
    expect((await hydra.owner({
      args: [
        'task',
        'show',
        'questions',
        '--full',
      ],
    })).task.asks).toContainEqual(expect.objectContaining({
      id: managed.ask,
      deferredUntil: '2099-01-01T09:00:00.000Z',
    }))
    const discussed = await asWorker.run({
      args: [
        'task',
        'discuss-question',
        'questions',
        managed.ask,
        '--text',
        'CSV works with the existing importer',
      ],
    })
    expect(discussed.notices).toBeDefined()
    const answered = await asWorker.run({
      args: [
        'task',
        'answer',
        'questions',
        managed.ask,
        '--choice',
        'CSV',
      ],
    })
    expect(answered.notices).toBeDefined()
    const reopened = await asWorker.run({
      args: [
        'task',
        'reopen-question',
        'questions',
        managed.ask,
      ],
    })
    expect(reopened.event).toBeDefined()
    expect((await hydra.owner({
      args: [
        'task',
        'show',
        'questions',
        '--full',
      ],
    })).task.asks.find((ask: { id: string }) => ask.id === managed.ask).answered).toBeUndefined()
    await asHydra.run({
      args: [
        'task',
        'close-question',
        'questions',
        managed.ask,
      ],
    })
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

    const accepted = async ({ args }: { args: string[] }) => {
      const result = await asHydra.run({ args })
      expect(result.notices).toBeDefined()
      expect((await hydra.task({ key: 'questions' })).notices).toBeDefined()
      await asHydra.run({
        args: [
          'task',
          'close-question',
          'questions',
          result.ask,
          '--reason',
          'Presentation checked',
          '--evidence',
          'The question was recorded',
        ],
      })
    }

    for (let omitted = 0; omitted < fields.length; omitted++) {
      const args = [
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
      ]

      if (omitted === 0 || omitted === 2) {
        expect((await asHydra.refused({ args })).code).toBe('VALIDATION_ERROR')
      } else {
        await accepted({ args })
      }
    }

    await accepted({
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
    })

    for (const question of [
      '?',
      'Ready for review',
      'Ship CSV? Or JSON?',
    ]) {
      await accepted({
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
      })
    }

    for (const badContext of [
      'Totals change after the answer.',
      `[Export](pnyx-task:${card.id})`,
      '[Wrong](pnyx-task:another-card)',
      `Totals change after the answer. ](pnyx-task:${card.id})`,
    ]) {
      await accepted({
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
      })
    }

    await workerLine({
      hydra,
      key: 'questions',
      line: 'needs-you: Ready for review',
    })
    const beforeReminder = await hydra.owner({
      args: [
        'task',
        'show',
        card.id,
        '--full',
      ],
    })
    expect(beforeReminder.task.workerLog.status).toMatchObject({ code: 'needs-you' })

    const due = new Date(Date.now() + 60_000).toISOString()
    await hydra.owner({
      args: [
        'task',
        'remind',
        'questions',
        due,
      ],
    })
    await fireReminders({
      hydraId: hydra.id,
      at: new Date(Date.parse(due) + 1).toISOString(),
    })
    const afterReminder = await hydra.owner({
      args: [
        'task',
        'show',
        card.id,
        '--full',
      ],
    })
    expect(afterReminder.task.workerLog).toEqual(beforeReminder.task.workerLog)
    const updates = await hydra.owner({
      args: [
        'task',
        'updates',
        'questions',
      ],
    })
    expect(JSON.stringify(updates)).toContain('task.reminder-due')
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
    await until({
      what: 'the Hydra summary to reflect no owner questions',
      check: () => (pnyx.home().hydras.find(summary => summary.id === hydra.id))?.asks === 0,
    })
    expect((pnyx.home().hydras.find(summary => summary.id === hydra.id))?.asks).toBe(0)
    expect((await asHydra.run({
      args: [
        'task',
        'escalate',
        'questions',
        workerAsk.ask,
        '--reason',
        'Accounting decision',
      ],
    })).notices).toBeDefined()
    expect((await asHydra.run({
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
    })).notices).toBeDefined()
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
        '--no-start',
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
          '--no-start',
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
    const summary = await until({
      what: 'the grouped owner decision in the project summary',
      check: () => {
        const summary = pnyx.home().hydras.find(summary => summary.id === hydra.id)

        if (summary?.projects.some(project => project.name === 'exports' && project.asks === 1)) {
          return summary
        }
      },
    })
    expect(summary).toMatchObject({
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
    const answered = await asHydra.run({ args: answer })
    expect(answered.notices).toBeDefined()
    const repeated = await asHydra.run({ args: answer })
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
    const recovered = await asHydra.run({ args: answer })
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
        '--no-start',
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
          '--no-start',
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

test(
  'a push updates task fields while observing an attached session',
  async () => {
    const hydra = await pnyx.hydra()
    await hydra.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--key',
        'parent',
        '--title',
        'Parent',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--key',
        'observed',
        '--title',
        'Before',
      ],
    })
    const folder = hydra.folder({ name: 'observed' })
    const firstObservation = await hydra.owner({
      args: [
        'push',
        '--key',
        'observed',
        '--event-id',
        'first-session-observation',
        '--file',
        '-',
      ],
      input: JSON.stringify({
        title: 'After',
        parent: 'parent',
        project: 'shop',
        workspace: 'work',
        tags: ['review'],
        folder,
        agent: {
          provider: 'claude',
          sessionId: 'observed',
        },
        activity: 'working',
      }),
    })
    const retried = await hydra.owner({
      args: [
        'push',
        '--key',
        'observed',
        '--event-id',
        'first-session-observation',
        '--file',
        '-',
      ],
      input: JSON.stringify({
        agent: {
          provider: 'claude',
          sessionId: 'observed',
        },
      }),
    })
    expect(retried.event).toEqual(firstObservation.event)
    expect(retried.duplicate).toContain('nothing appended')
    expect((await hydra.ownerRefused({
      args: [
        'push',
        '--key',
        'parent',
        '--event-id',
        'first-session-observation',
        '--file',
        '-',
      ],
      input: JSON.stringify({ title: 'Unrelated write' }),
    })).code).toBe('IDEMPOTENCY_CONFLICT')
    const outside = await hydra.owner({
      args: [
        'push',
        '--key',
        'outside-receipt',
        '--event-id',
        'outside-observation',
        '--file',
        '-',
      ],
      input: JSON.stringify({
        agent: {
          provider: 'claude',
          sessionId: 'receipt-only',
        },
      }),
    })
    expect((await hydra.owner({
      args: [
        'push',
        '--key',
        'outside-receipt',
        '--event-id',
        'outside-observation',
        '--file',
        '-',
      ],
      input: JSON.stringify({
        agent: {
          provider: 'claude',
          sessionId: 'receipt-only',
        },
      }),
    })).event).toEqual(outside.event)
    expect((await hydra.ownerRefused({
      args: [
        'push',
        '--key',
        '$sessions',
        '--event-id',
        'outside-observation',
        '--file',
        '-',
      ],
      input: JSON.stringify({ title: 'Unrelated write' }),
    })).code).toBe('IDEMPOTENCY_CONFLICT')
    const result = await hydra.owner({
      args: [
        'task',
        'show',
        'observed',
        '--full',
      ],
    })
    expect(result.task).toMatchObject({
      title: 'After',
      parentId: (await hydra.task({ key: 'parent' })).id,
      project: 'shop',
      workspace: 'work',
      tags: ['review'],
      folder,
      activity: 'working',
    })
    await hydra.owner({
      args: [
        'push',
        '--key',
        'observed',
        '--file',
        '-',
      ],
      input: JSON.stringify({
        parent: null,
        project: null,
        folder: null,
        agent: {
          provider: 'claude',
          sessionId: 'observed',
        },
      }),
    })
    const cleared = await hydra.owner({
      args: [
        'task',
        'show',
        'observed',
        '--full',
      ],
    })
    expect(cleared.task.parentId).toBeUndefined()
    expect(cleared.task.project).toBeUndefined()
    expect(cleared.task.folder).toBeUndefined()
    await hydra.owner({
      args: [
        'push',
        '--key',
        'parent',
        '--file',
        '-',
      ],
      input: JSON.stringify({
        title: 'Parent updated',
        agent: {
          provider: 'claude',
          sessionId: 'observed',
        },
      }),
    })
    expect((await hydra.task({ key: 'observed' })).title).toBe('After')
    const parent = (await hydra.owner({
      args: [
        'task',
        'show',
        'parent',
        '--full',
      ],
    })).task
    expect(parent.title).toBe('Parent updated')
    expect(parent.sessionIds ?? []).toEqual([])
    const stillAssigned = (await hydra.owner({
      args: [
        'task',
        'show',
        'observed',
        '--full',
      ],
    })).task
    expect(stillAssigned.agent.sessionId).toBe('observed')
    await hydra.owner({
      args: [
        'push',
        '--key',
        'observed',
        '--file',
        '-',
      ],
      input: JSON.stringify({
        agent: {
          provider: 'claude',
          sessionId: 'unassigned-observation',
        },
        activity: 'ended',
      }),
    })
    expect((await hydra.task({ key: 'observed' })).status).toBe('running')
    expect((await hydra.owner({
      args: [
        'task',
        'sessions',
      ],
    })).sessions).toContainEqual(expect.objectContaining({
      id: 'claude:unassigned-observation',
      task: 'none',
    }))
    await hydra.owner({
      args: [
        'push',
        '--key',
        'observed',
        '--file',
        '-',
      ],
      input: JSON.stringify({
        title: null,
        agent: {
          provider: 'claude',
          sessionId: 'observed',
        },
      }),
    })
    expect((await hydra.owner({
      args: [
        'task',
        'sessions',
      ],
    })).sessions).toContainEqual(expect.objectContaining({
      id: 'claude:observed',
      title: 'none',
    }))
    expect((await hydra.task({ key: 'observed' })).title).toBe('observed')
    await hydra.owner({
      args: [
        'push',
        '--key',
        'observed',
        '--file',
        '-',
      ],
      input: JSON.stringify({
        agent: {
          provider: 'claude',
          sessionId: 'observed',
        },
        autoTitle: {
          from: 'prompt',
          text: 'Read the export settings',
        },
      }),
    })
    expect((await hydra.task({ key: 'observed' })).title).toBe('Read the export settings')
  },
)

test(
  'workers can manage task policies and receipts retain their notices on the card',
  async () => {
    const hydra = await pnyx.hydra()
    await hydra.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--key',
        'policies',
        '--title',
        'Policy defaults',
      ],
    })
    await hydra.owner({
      args: [
        'task',
        'create',
        '--no-start',
        '--key',
        'prerequisite',
        '--title',
        'Prerequisite',
      ],
    })
    const staying = await hydra.owner({
      args: [
        'task',
        'move',
        'policies',
        '--to-hydra',
        hydra.id,
      ],
    })
    expect(staying.state).toBe('unchanged')
    expect(staying.notices).toBeDefined()
    const actor = [
      '--actor',
      'worker:policies',
    ]

    for (const args of [
      [
        'task',
        'depend',
        'policies',
        '--on',
        'prerequisite',
      ],
      [
        'task',
        'hold',
        'policies',
      ],
      [
        'task',
        'tools',
        'policies',
        '--grant',
        'browser',
      ],
      [
        'task',
        'landing',
        'policies',
        '--landing',
        'branch',
      ],
      [
        'task',
        'owner-ask',
        'policies',
        '--text',
        'Keep the result visible',
      ],
    ]) {
      const receipt = await hydra.owner({
        args: [
          ...args,
          ...actor,
        ],
      })
      expect(receipt.notices).toEqual(expect.arrayContaining([
        expect.objectContaining({
          reason: expect.any(String),
          clear: expect.stringMatching(/\S/),
        }),
      ]))

      for (const notice of receipt.notices) {
        expect(notice.clear).not.toMatch(/\bpnyx-axi\b/)
      }

      expect((await hydra.task({ key: 'policies' })).notices).toEqual(expect.arrayContaining([expect.objectContaining({ reason: expect.any(String) })]))
      const saved = (await hydra.owner({
        args: [
          'task',
          'show',
          'policies',
          '--full',
        ],
      })).task

      if (args[1] === 'depend') {
        expect(saved.prerequisites).toEqual([(await hydra.task({ key: 'prerequisite' })).id])
      }

      if (args[1] === 'hold') {
        expect(saved.hold.reason).toBe('Discussion hold requested by worker:policies')
      }

      if (args[1] === 'owner-ask') {
        expect(saved.ask).toContainEqual(expect.objectContaining({
          text: 'Keep the result visible',
          actor: 'worker:policies',
        }))
      }
    }

    const full = await hydra.owner({
      args: [
        'task',
        'show',
        'policies',
        '--full',
      ],
    })
    expect(full.task.tools).toContain('browser')
    expect(full.task.landing).toEqual({
      landing: 'branch',
      merge: 'owner',
    })
    const batch = await operation({
      args: [
        'apply',
        '--file',
        '-',
        '--hydra',
        hydra.id,
      ],
      env: {
        ...process.env,
        PNYX_ACTOR: 'worker:policies',
        PNYX_HYDRA: hydra.id,
      },
      input: JSON.stringify({
        version: 1,
        changes: [
          {
            op: 'task.owner-ask',
            task: 'policies',
            text: 'Keep this additional instruction visible',
          },
          {
            op: 'task.brief',
            task: 'prerequisite',
            brief: 'Unrelated task instruction',
          },
        ],
      }),
    })
    expect(
      batch.status,
      batch.stdout,
    ).toBe(0)
    const unrelated = (await hydra.owner({
      args: [
        'task',
        'show',
        'prerequisite',
        '--full',
      ],
    })).task
    expect(unrelated.notices ?? []).not.toContainEqual(expect.objectContaining({ reason: 'Ask recorded without a saved owner message' }))

    const released = await hydra.owner({
      args: [
        'task',
        'release',
        'policies',
        '--reason',
        'Continue the task',
        ...actor,
      ],
    })
    expect(released.notices).toBeDefined()
    expect((await hydra.task({ key: 'policies' })).hold).toBeUndefined()
    await hydra.owner({
      args: [
        'task',
        'brief',
        'policies',
        '--intent',
        'Policy notices reviewed',
      ],
    })
    expect((await hydra.owner({
      args: [
        'task',
        'show',
        'policies',
        '--full',
      ],
    })).task.notices).toEqual([])
    const overdue = await hydra.owner({
      args: [
        'task',
        'remind',
        'policies',
        '2000-01-01T00:00:00Z',
      ],
    })
    expect(overdue.notices).toContainEqual(expect.objectContaining({ reason: 'Reminder time has passed; the reminder is due now' }))
    await hydra.owner({
      args: [
        'task',
        'remind',
        'policies',
        'clear',
      ],
    })
    await hydra.owner({
      args: [
        'outcome',
        'policies',
        'done',
        '--note',
        'Finished policy changes',
      ],
    })
    const stoppedRecurrence = await hydra.owner({
      args: [
        'task',
        'remind',
        'policies',
        'in 1 hour',
        '--every',
        '1 hour',
        '--until',
        'task-done',
      ],
    })
    expect(stoppedRecurrence.notices).toContainEqual(expect.objectContaining({ reason: 'Task is already done; its recurring reminder stops immediately' }))
    expect((await hydra.owner({
      args: [
        'task',
        'show',
        'policies',
        '--full',
      ],
    })).task.reminder).toBeUndefined()
  },
)

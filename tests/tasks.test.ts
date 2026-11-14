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

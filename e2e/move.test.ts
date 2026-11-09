import assert from 'node:assert/strict'
import { test } from 'node:test'
import { until } from '#test-harness/harness.ts'
import { pnyx } from '#test-harness/pnyx.ts'

test(
  'a paused worker moves to another Hydra with its task copy, resumes its own session there, and the old Hydra never hands that copy to another task',
  async () => {
    const s = await pnyx.scenario()
    const target = await pnyx.scenario()
    const app = await s.project({ name: 'app' })
    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'Ship',
        '--key',
        'ship',
        '--project',
        app,
        '--ask',
        'ship it',
      ],
    })
    await s.owner({
      args: [
        'task',
        'start',
        'ship',
      ],
    })
    const copy = s.task({ key: 'ship' }).copy!.path
    const agent = await s.agent({ cwd: copy })
    const worker = s.as({ agent })
    await worker.run({
      args: [
        'task',
        'status',
        'ship',
        'paused',
        '--note',
        'waiting for review',
      ],
    })
    await until({
      what: 'the first turn to end',
      check: () => s.task({ key: 'ship' }).sessionActivity === 'finished',
    })
    const id = s.task({ key: 'ship' }).id
    const move = [
      'task',
      'move',
      id,
      '--to-hydra',
      target.hydraId,
    ]

    const missing = await s.ownerRefusal({ args: move })
    assert.equal(
      missing.code,
      'NOT_FOUND',
    )
    assert.match(
      missing.error!,
      new RegExp(`Hydra ${target.hydraId} has no project`),
    )
    const preview = await target.owner({
      args: [
        'project',
        'add',
        app,
      ],
    })
    await target.owner({
      args: [
        'project',
        'add',
        app,
        '--confirm',
        /^token: (\S+)$/m.exec(preview)![1]!,
      ],
    })

    const sessions = s.task({ key: 'ship' }).sessionIds
    await s.owner({ args: move })
    const moved = target.task({ key: 'ship' })
    assert.deepEqual(
      [
        moved.id,
        moved.copy?.path,
        moved.sessionIds,
        moved.status?.note,
        moved.ask?.map(a => a.text),
      ],
      [
        id,
        copy,
        sessions,
        'waiting for review',
        ['ship it'],
      ],
    )
    assert.equal(
      s.state().cards[id],
      undefined,
    )
    assert.match(
      (await worker.refusal({
        args: [
          'task',
          'show',
          id,
        ],
      })).error!,
      new RegExp(`moved to Hydra ${target.hydraId}`),
    )

    await target.owner({
      args: [
        'reply',
        id,
        '--text',
        'Carry on here',
      ],
    })
    const resumed = await target.agent({ cwd: copy })
    assert.equal(
      resumed.id,
      agent.id,
    )
    await until({
      what: 'the resumed worker to hear the owner',
      check: () => resumed.received.some(text => text.includes('Carry on here')),
    })

    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'Other',
        '--key',
        'other',
        '--project',
        app,
      ],
    })
    await s.owner({
      args: [
        'task',
        'start',
        'other',
      ],
    })
    assert.notEqual(
      s.task({ key: 'other' }).copy?.path,
      copy,
    )
  },
)

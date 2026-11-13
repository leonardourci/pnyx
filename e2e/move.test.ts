import assert from 'node:assert/strict'
import { test } from 'node:test'
import { until } from '#test-harness/harness.ts'
import { pnyx } from '#test-harness/pnyx.ts'

test(
  'a paused worker moves to another Hydra with its task copy and resumes its own session there, once it is between turns and nothing is queued behind it',
  async () => {
    // Fake agent plans answer the newest scenario, so the source, whose worker holds a turn, comes second.
    const target = await pnyx.scenario()
    const s = await pnyx.scenario()
    const app = await s.project({ name: 'app' })

    for (const key of [
      'ship',
      'next',
    ]) {
      await s.owner({
        args: [
          'task',
          'create',
          '--title',
          key,
          '--key',
          key,
          '--project',
          app,
          '--ask',
          `${key} it`,
        ],
      })
    }

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
    const finished = () => until({
      what: 'the worker to finish its turn',
      check: () => s.task({ key: 'ship' }).sessionActivity === 'finished',
    })
    await finished()
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

    const held = pnyx.claude.plan({
      match: ({ text }) => text.includes('Keep going'),
      hold: true,
    })

    try {
      await s.owner({
        args: [
          'reply',
          id,
          '--text',
          'Keep going',
        ],
      })
      await until({
        what: 'the worker to work on the message',
        check: () => s.task({ key: 'ship' }).sessionActivity === 'working',
      })
      assert.equal(
        (await s.ownerRefusal({ args: move })).code,
        'CONFLICT',
      )
      assert.ok(s.state().cards[id])
      assert.equal(
        target.state().cards[id],
        undefined,
      )
    } finally {
      held.release()
    }

    await finished()
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

    await s.owner({
      args: [
        'task',
        'queue',
        'next',
        '--behind',
        'ship',
      ],
    })
    assert.match(
      (await s.ownerRefusal({ args: move })).error!,
      /is queued behind/,
    )
    await s.owner({
      args: [
        'task',
        'unqueue',
        'next',
      ],
    })

    const sessions = s.task({ key: 'ship' }).sessionIds
    await s.owner({ args: move })
    assert.equal(
      agent.closed,
      true,
    )
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
    assert.ok((await target.owner({
      args: [
        'task',
        'sessions',
        id,
      ],
    })).includes(sessions![0]!))

    await pnyx.restart()
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
      what: 'the resumed worker to get the reply sent on the new Hydra',
      check: () => resumed.received.some(text => text.includes('Carry on here')),
    })

    // Guards the folder the moved worker still runs in: the old Hydra must not hand it to its next task.
    await s.owner({
      args: [
        'task',
        'start',
        'next',
      ],
    })
    assert.notEqual(
      s.task({ key: 'next' }).copy?.path,
      copy,
    )
  },
)

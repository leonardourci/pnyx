import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { taskReadiness } from '../../src/core/dependencies.ts'
import { hydraDigest } from '../../src/core/digest.ts'
import { boardReview } from '../../src/review/board.ts'
import { scenarioGroup, until } from './harness.ts'

const pnyx = scenarioGroup({ incorporateSteering: true })

test(
  'dependencies persist, reject invalid graphs, and leave independent tasks available in parallel',
  async () => {
    const s = await pnyx.scenario()
    const hydra = await s.chat({ text: 'Track prerequisite readiness.' })

    for (const key of [
      'first',
      'second',
      'dependent',
    ]) {
      await s.owner({
        args: [
          'task',
          'create',
          '--key',
          key,
          '--title',
          key,
          '--folder',
          s.folder({ name: key }),
        ],
      })
    }

    await s.owner({
      args: [
        'task',
        'depend',
        'dependent',
        '--on',
        'first',
        '--on',
        'second',
        '--event-id',
        'deps',
      ],
    })
    const count = s.events().filter(event => event.type === 'task.dependencies').length
    await s.owner({
      args: [
        'task',
        'depend',
        'dependent',
        '--on',
        'first',
        '--on',
        'second',
        '--event-id',
        'deps',
      ],
    })
    assert.equal(
      s.events().filter(event => event.type === 'task.dependencies').length,
      count,
    )
    assert.deepEqual(
      s.task({ key: 'dependent' }).prerequisites,
      [
        s.task({ key: 'first' }).id,
        s.task({ key: 'second' }).id,
      ],
    )

    for (const args of [
      [
        'task',
        'depend',
        'first',
        '--on',
        'dependent',
      ],
      [
        'task',
        'depend',
        'first',
        '--on',
        'first',
      ],
    ]) {
      assert.equal(
        (await s.ownerRefusal({ args })).code,
        'DEPENDENCY_CYCLE',
      )
    }

    assert.equal(
      (await s.ownerRefusal({
        args: [
          'task',
          'depend',
          'first',
          '--on',
          'missing',
        ],
      })).code,
      'NOT_FOUND',
    )
    const blocked = await s.ownerRefusal({
      args: [
        'task',
        'start',
        'dependent',
      ],
    })
    assert.equal(
      blocked.code,
      'TASK_NOT_READY',
    )
    assert.match(
      blocked.error!,
      /first.*second/,
    )
    assert.equal(
      s.task({ key: 'dependent' }).launch,
      undefined,
    )

    for (const key of [
      'first',
      'second',
    ]) {
      await s.owner({
        args: [
          'task',
          'start',
          key,
        ],
      })
    }

    assert.ok(s.task({ key: 'first' }).sessionIds?.length)
    assert.ok(s.task({ key: 'second' }).sessionIds?.length)
    const worker = s.as({ agent: await s.agent({ cwd: s.task({ key: 'first' }).folder! }) })
    assert.equal(
      (await worker.refusal({
        args: [
          'task',
          'undepend',
          'dependent',
          '--on',
          'first',
        ],
      })).code,
      'OWNER_ONLY',
    )

    const state = s.state()
    assert.match(
      hydraDigest({
        state,
        hydraId: s.hydraId,
        owner: {},
      }),
      /waiting: first.*second/,
    )
    assert.match(
      boardReview({
        state,
        now: Date.now(),
      }).block,
      /Prerequisite: waiting for first/,
    )
    await s.owner({
      args: [
        'task',
        'show',
        'dependent',
      ],
    })
    await until({
      what: 'Hydra to hear the named prerequisite',
      check: () => hydra.received.some(text => text.includes('prerequisite: waiting for first')),
    })

    rmSync(
      join(
        process.env.PNYX_HOME!,
        'hydras',
        s.hydraId,
        'snapshot.json',
      ),
      { force: true },
    )
    await pnyx.restart()
    assert.equal(
      taskReadiness({
        state: s.state(),
        card: s.task({ key: 'dependent' }),
      }).ready,
      false,
    )
    await s.owner({
      args: [
        'task',
        'undepend',
        'dependent',
        '--on',
        'first',
        '--on',
        'second',
      ],
    })
    await s.owner({
      args: [
        'task',
        'start',
        'dependent',
      ],
    })
    assert.ok(s.task({ key: 'dependent' }).sessionIds?.length)
  },
)

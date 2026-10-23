import assert from 'node:assert/strict'
import { test } from 'node:test'
import { scenarioGroup } from './harness.ts'

const pnyx = scenarioGroup()

test(
  'column rules route new work, owner questions and manual exceptions through the real CLI',
  async () => {
    const s = await pnyx.scenario()

    const run = async ({ args }: { args: string[] }) => {
      const preview = await s.owner({ args })
      const token = /^token: (\S+)$/m.exec(preview)?.[1]

      if (token) {
        return s.owner({
          args: [
            ...args,
            '--confirm',
            token,
          ],
        })
      }

      return preview
    }

    await run({
      args: [
        'column',
        'create',
        '--id',
        'custom:research',
        '--title',
        'Research',
      ],
    })
    await run({
      args: [
        'column',
        'reorder',
        'custom:research',
        '--before',
        'queued',
      ],
    })
    await run({
      args: [
        'column',
        'rule',
        'custom:research',
        '--when',
        'kind:investigation,!held,!done,!owner-question,!reminder-due',
        '--reason',
        'Research has its own phase',
      ],
    })
    await run({
      args: [
        'task',
        'create',
        '--title',
        'Compare storage options',
        '--key',
        'research',
        '--kind',
        'investigation',
      ],
    })
    assert.equal(
      s.task({ key: 'research' }).column,
      'custom:research',
    )
    await run({
      args: [
        'move',
        'research',
        'parked',
        '--reason',
        'Set aside while reviewing findings',
      ],
    })
    await run({
      args: [
        'task',
        'status',
        'research',
        'working',
        '--note',
        'Comparing options',
      ],
    })
    assert.equal(
      s.task({ key: 'research' }).column,
      s.column({ role: 'parked' }),
    )
    const question = await run({
      args: [
        'task',
        'ask',
        'research',
        '--to',
        'owner',
        '--actor',
        'hydra',
        '--reason',
        'The owner chooses the scope',
        '--question',
        'Which option should we investigate?',
        '--choice',
        'SQLite',
        '--choice',
        'Files',
      ],
    })
    assert.equal(
      s.task({ key: 'research' }).column,
      s.column({ role: 'needs_you' }),
    )
    const ask = /^ask: (\S+)$/m.exec(question)![1]!
    await run({
      args: [
        'task',
        'answer',
        'research',
        ask,
        '--choice',
        'Files',
      ],
    })
    assert.equal(
      s.task({ key: 'research' }).column,
      'custom:research',
    )
    await run({
      args: [
        'task',
        'create',
        '--title',
        'Discuss a new feature',
        '--key',
        'idea',
        '--kind',
        'investigation',
        '--hold',
        '--reason',
        'Discuss before doing',
      ],
    })
    assert.equal(
      s.task({ key: 'idea' }).column,
      s.column({ role: 'queued' }),
    )
    assert.equal(
      await s.ownerRefused({
        args: [
          'task',
          'start',
          'idea',
        ],
      }),
      'TASK_HELD',
    )
    const listed = await run({
      args: [
        'column',
        'list',
      ],
    })
    assert.match(
      listed,
      /kind:investigation/,
    )
    assert.ok(s.events().some(event => event.type === 'card.moved' && event.actor === 'pnyx' && event.cardId === s.task({ key: 'research' }).id))
  },
)

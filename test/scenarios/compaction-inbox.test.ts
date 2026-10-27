import assert from 'node:assert/strict'
import { test } from 'node:test'
import { COMMENT_NOTE } from '../../src/compaction/comments.ts'
import { scenarioGroup, until } from '../../src/test-harness/harness.ts'

const pnyx = scenarioGroup()

test(
  'selected compact input and unacknowledged worker instructions survive repeated restarts',
  async () => {
    const s = await pnyx.scenario()
    const folder = s.folder({ name: 'worker' })
    await s.owner({
      args: [
        'task',
        'create',
        '--key',
        'work',
        '--title',
        'Work',
        '--folder',
        folder,
      ],
    })
    await s.owner({
      args: [
        'task',
        'start',
        'work',
        '--harness',
        'codex',
      ],
    })
    await until({
      what: 'worker opening turn finished',
      check: () => s.task({ key: 'work' }).sessionActivity === 'finished',
    })
    const held = pnyx.codex.plan({
      text: '/compact',
      hold: true,
    })

    try {
      await s.owner({
        args: [
          'reply',
          'work',
          '--text',
          '/compact',
        ],
      })
      await until({
        what: 'manual compact running',
        check: () => s.task({ key: 'work' }).compaction?.operations.at(-1)?.state === 'running',
      })

      for (const [
        id,
        text,
      ] of [
          [
            'first',
            'First instruction',
          ],
          [
            'second',
            'Second instruction',
          ],
        ]) {
        await s.owner({
          args: [
            'reply',
            'work',
            '--idempotency-key',
            id!,
            '--text',
            text!,
          ],
        })
      }

      await s.owner({
        args: [
          'agent',
          'work',
          '--send-now',
          'second',
        ],
      })
      await until({
        what: 'native cancellation confirmed',
        check: () => s.task({ key: 'work' }).compaction?.operations.at(-1)?.state === 'cancelled',
      })
      await pnyx.restart()
      let worker = s.as({ agent: await s.agent({ cwd: folder }) })
      const pending = await worker.run({
        args: [
          'task',
          'inbox',
          'read',
          'work',
        ],
      })
      assert.ok(
        pending.indexOf('Second instruction') < pending.indexOf('First instruction'),
        pending,
      )
      const card = s.task({ key: 'work' })
      const ack = ({
        id,
        generation = card.steeringGeneration!,
      }: {
        id: string
        generation?: number
      }) => [
        'task',
        'inbox',
        'ack',
        'work',
        id,
        '--session',
        card.sessionIds![0]!,
        '--generation',
        String(generation),
      ]
      assert.equal(
        await worker.refused({ args: ack({ id: 'first' }) }),
        'VALIDATION_ERROR',
      )
      assert.equal(
        await worker.refused({
          args: ack({
            id: 'second',
            generation: card.steeringGeneration! + 1,
          }),
        }),
        'STALE_CLAIM',
      )
      await worker.run({ args: ack({ id: 'second' }) })
      await worker.run({ args: ack({ id: 'second' }) })
      await pnyx.restart()
      worker = s.as({ agent: await s.agent({ cwd: folder }) })
      const remaining = await worker.run({
        args: [
          'task',
          'inbox',
          'read',
          'work',
        ],
      })
      assert.match(
        remaining,
        /First instruction/,
      )
      assert.doesNotMatch(
        remaining,
        /Second instruction/,
      )
      await worker.run({ args: ack({ id: 'first' }) })
      assert.equal(
        s.events().filter(event => event.type === 'task.steering.handled').length,
        2,
      )
      assert.equal(
        s.task({ key: 'work' }).steering?.filter(message => message.ack).length,
        2,
      )
      assert.equal(
        s.received({ cwd: folder }).filter(text => text.trim() === '/compact').length,
        1,
      )
    } finally {
      held.release()
    }
  },
)

test(
  'worker comments are taught once per successful compact and failed compacts retain the epoch',
  async () => {
    const s = await pnyx.scenario()
    const folder = s.folder({ name: 'comments' })
    await s.owner({
      args: [
        'task',
        'create',
        '--key',
        'work',
        '--title',
        'Comments',
        '--folder',
        folder,
      ],
    })
    await s.owner({
      args: [
        'task',
        'start',
        'work',
      ],
    })
    await until({
      what: 'worker opening turn finished',
      check: () => s.task({ key: 'work' }).sessionActivity === 'finished',
    })

    const comment = async ({
      id,
      taught,
    }: {
      id: string
      taught: boolean
    }) => {
      await s.owner({
        args: [
          'reply',
          'work',
          '--idempotency-key',
          id,
          '--text',
          '## Comments on your reply from today\nPlease clarify.',
        ],
      })
      const worker = s.as({ agent: await s.agent({ cwd: folder }) })
      await until({
        what: 'comment teaching recorded',
        check: () => Boolean(s.task({ key: 'work' }).compaction?.taughtEpoch),
      })
      const read = await worker.run({
        args: [
          'task',
          'inbox',
          'read',
          'work',
        ],
      })
      assert.equal(
        read.includes(COMMENT_NOTE),
        taught,
        read,
      )
      const card = s.task({ key: 'work' })
      await worker.run({
        args: [
          'task',
          'inbox',
          'ack',
          'work',
          id,
          '--session',
          card.sessionIds![0]!,
          '--generation',
          String(card.steeringGeneration),
        ],
      })
      await until({
        what: 'comment notice finished',
        check: () => s.task({ key: 'work' }).sessionActivity === 'finished',
      })
    }

    await comment({
      id: 'initial-comment',
      taught: true,
    })
    await comment({
      id: 'next-comment',
      taught: false,
    })
    await s.owner({
      args: [
        'reply',
        'work',
        '--text',
        '/compact',
      ],
    })
    await until({
      what: 'successful native compact',
      check: () => s.task({ key: 'work' }).compaction?.operations.at(-1)?.state === 'done',
    })
    await comment({
      id: 'after-compact',
      taught: true,
    })
    await comment({
      id: 'already-taught',
      taught: false,
    })
    pnyx.claude.plan({
      text: '/compact',
      fail: 'Compaction failed',
    })
    await s.owner({
      args: [
        'reply',
        'work',
        '--text',
        '/compact',
      ],
    })
    await until({
      what: 'failed native compact',
      check: () => s.task({ key: 'work' }).compaction?.operations.at(-1)?.state === 'failed',
    })
    await comment({
      id: 'after-failure',
      taught: false,
    })
  },
)

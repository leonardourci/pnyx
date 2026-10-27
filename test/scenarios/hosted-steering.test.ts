import assert from 'node:assert/strict'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { askHost } from '../../src/server/state.ts'
import { pausedDeclaration } from '../../src/core/lifecycle.ts'
import { steeringNotice } from '../../src/task-inbox/notice.ts'
import { scenarioGroup, until } from '../../src/test-harness/harness.ts'

const pnyx = scenarioGroup()

for (const harness of [
  'claude',
  'codex',
] as const) {
  test(
    `${harness}: busy delivery and restart retain exact pending IDs until worker checkpoints`,
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
          harness,
        ],
      })
      const first = await s.agent({ cwd: folder })
      const worker = s.as({ agent: first })
      const card = () => s.task({ key: 'work' })
      const pending = () => (card().steering ?? [])
        .filter(message => !message.ack).map(message => message.id)
      const idle = () => until({
        what: 'worker idle',
        check: () => card().sessionActivity === 'finished',
      })
      const notice = ({ ids }: { ids: string[] }) => steeringNotice({
        task: card().id,
        hydraId: s.hydraId,
        ids,
      })
      const ack = async ({ id }: { id: string }) => worker.run({
        args: [
          'task',
          'inbox',
          'ack',
          'work',
          id,
          '--session',
          card().sessionIds![0]!,
          '--generation',
          String(card().steeringGeneration),
        ],
      })
      await idle()
      const held = pnyx[harness].plan({
        text: notice({ ids: ['first'] }),
        hold: true,
      })

      try {
        await s.owner({
          args: [
            'reply',
            'work',
            '--idempotency-key',
            'first',
            '--text',
            'First instruction',
          ],
        })
        await until({
          what: 'held instruction reaches provider',
          check: () => s.received({ cwd: folder }).includes(notice({ ids: ['first'] })),
        })
        const prefix = 'Same beginning '.repeat(20)
        await s.owner({
          args: [
            'reply',
            'work',
            '--idempotency-key',
            'second',
            '--text',
            `${prefix}\nOlá 🌊\n第二行`,
          ],
        })
        await s.owner({
          args: [
            'reply',
            'work',
            '--idempotency-key',
            'third',
            '--text',
            `${prefix}\nDifferent ending`,
          ],
        })
        assert.deepEqual(
          pending(),
          [
            'first',
            'second',
            'third',
          ],
        )
        assert.equal(
          card().steering![0]!.attempts[0]!.result,
          'delivered',
        )
        assert.equal(
          card().steering![0]!.ack,
          undefined,
        )

        if (harness === 'codex') {
          await until({
            what: 'mid-turn notices steer Codex',
            check: () => first.requests!.filter(method => method === 'turn/steer').length === 2,
          })
        }

        await ack({ id: 'first' })
        await ack({ id: 'first' })
        await s.owner({
          args: [
            'reply',
            'work',
            '--idempotency-key',
            'first',
            '--text',
            'First instruction',
          ],
        })
        assert.equal(
          card().steering!.length,
          3,
        )
        assert.equal(
          s.events().filter(event => event.type === 'task.steering.handled').length,
          1,
        )
        await pnyx.restart()
        await until({
          what: 'pending IDs replay on resume',
          check: () => s.received({ cwd: folder }).includes(notice({
            ids: [
              'second',
              'third',
            ],
          })),
        })
        assert.deepEqual(
          pending(),
          [
            'second',
            'third',
          ],
        )
        const resumed = s.as({ agent: await s.agent({ cwd: folder }) })
        const read = await resumed.run({
          args: [
            'task',
            'inbox',
            'read',
            'work',
          ],
        })
        assert.match(
          read,
          /Olá 🌊/,
        )
        assert.match(
          read,
          /第二行/,
        )
        assert.match(
          read,
          /Different ending/,
        )
        assert.doesNotMatch(
          read,
          /First instruction/,
        )
        const rerun = {
          action: 'send',
          card: card().id,
          text: '',
          steering: 'second',
          attempt: 'rerung',
        }
        await askHost({
          hydraId: s.hydraId,
          body: rerun,
        })
        await askHost({
          hydraId: s.hydraId,
          body: rerun,
        })
        assert.equal(
          card().steering![1]!.attempts.filter(attempt => attempt.id === 'rerung').length,
          1,
        )
        await askHost({
          hydraId: s.hydraId,
          body: {
            ...rerun,
            steering: 'first',
            attempt: 'after-ack',
          },
        })
        assert.equal(
          card().steering![0]!.attempts.some(attempt => attempt.id === 'after-ack'),
          false,
        )

        assert.equal(
          s.received({ cwd: folder }).filter(text => text === notice({ ids: ['first'] })).length,
          1,
        )
        assert.deepEqual(
          card().steering!.map(message => message.order),
          [
            1,
            2,
            3,
          ],
        )
        assert.equal(
          card().replies!.find(reply => reply.id === 'second')!.state,
          'delivered',
        )
      } finally {
        held.release()
      }
    },
  )

  test(
    `${harness}: persistence before notification and action before acknowledgement recover without repeating checkpointed effects`,
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
          harness,
        ],
      })
      await s.agent({ cwd: folder })
      await until({
        what: 'opening turn finishes',
        check: () => s.task({ key: 'work' }).sessionActivity === 'finished',
      })
      await pnyx.restart({
        whileStopped: async () => {
          await s.owner({
            args: [
              'reply',
              'work',
              '--idempotency-key',
              'offline',
              '--text',
              'Apply exactly this instruction',
            ],
          })
          assert.equal(
            s.task({ key: 'work' }).steering![0]!.attempts.length,
            0,
          )
        },
      })
      const notice = steeringNotice({
        task: s.task({ key: 'work' }).id,
        hydraId: s.hydraId,
        ids: ['offline'],
      })
      await until({
        what: 'offline instruction recovered',
        check: () => s.received({ cwd: folder }).includes(notice),
      })
      const effects = join(
        folder,
        'checkpoints.jsonl',
      )

      const incorporate = async () => {
        const worker = s.as({ agent: await s.agent({ cwd: folder }) })
        const read = await worker.run({
          args: [
            'task',
            'inbox',
            'read',
            'work',
          ],
        })
        assert.match(
          read,
          /Apply exactly this instruction/,
        )
        const checkpointed = existsSync(effects) ? readFileSync(
          effects,
          'utf8',
        ).trim()
          .split('\n') : []

        for (const message of s.task({ key: 'work' }).steering!.filter(message => !message.ack)) {
          if (!checkpointed.includes(message.id)) {
            appendFileSync(
              effects,
              `${message.id}\n`,
            )
          }
        }

        return worker
      }

      await incorporate()
      assert.equal(
        s.task({ key: 'work' }).steering![0]!.ack,
        undefined,
      )
      const before = s.received({ cwd: folder }).filter(text => text === notice).length
      await pnyx.restart()
      await until({
        what: 'action without ack stays owed',
        check: () => s.received({ cwd: folder }).filter(text => text === notice).length > before,
      })
      const worker = await incorporate()
      const card = s.task({ key: 'work' })
      await worker.run({
        args: [
          'task',
          'inbox',
          'ack',
          'work',
          'offline',
          '--session',
          card.sessionIds![0]!,
          '--generation',
          String(card.steeringGeneration),
        ],
      })
      assert.equal(
        readFileSync(
          effects,
          'utf8',
        ),
        'offline\n',
      )
      const acknowledged = s.received({ cwd: folder }).filter(text => text === notice).length
      await pnyx.restart()
      assert.equal(
        s.received({ cwd: folder }).filter(text => text === notice).length,
        acknowledged,
      )
      assert.equal(
        s.task({ key: 'work' }).steering!.filter(message => !message.ack).length,
        0,
      )
    },
  )

  test(
    `${harness}: a busy held worker stays stopped across restart and its pending ID follows replacement`,
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
          harness,
        ],
      })
      const original = await s.agent({ cwd: folder })
      const worker = s.as({ agent: original })
      await until({
        what: 'opening turn finishes',
        check: () => s.task({ key: 'work' }).sessionActivity === 'finished',
      })
      const activeNotice = steeringNotice({
        task: s.task({ key: 'work' }).id,
        hydraId: s.hydraId,
        ids: ['active'],
      })
      const held = pnyx[harness].plan({
        text: activeNotice,
        hold: true,
      })

      try {
        await s.owner({
          args: [
            'reply',
            'work',
            '--idempotency-key',
            'active',
            '--text',
            'Work until paused',
          ],
        })
        await until({
          what: 'busy worker receives input',
          check: () => original.received.includes(activeNotice),
        })
        const claim = s.task({ key: 'work' })
        await worker.run({
          args: [
            'task',
            'inbox',
            'read',
            'work',
          ],
        })
        await worker.run({
          args: [
            'task',
            'inbox',
            'ack',
            'work',
            'active',
            '--session',
            claim.sessionIds![0]!,
            '--generation',
            String(claim.steeringGeneration),
          ],
        })
        await worker.run({
          args: [
            'task',
            'status',
            'work',
            'paused',
            '--hold',
            '--note',
            'Wait for go',
          ],
        })
        const received = s.received({ cwd: folder }).length
        const openings = pnyx[harness].sessions.filter(session => session.cwd === folder).length
        await s.owner({
          args: [
            'reply',
            'work',
            '--idempotency-key',
            'held',
            '--text',
            'Keep this instruction',
          ],
        })
        assert.equal(
          pausedDeclaration({ card: s.task({ key: 'work' }) })?.hold,
          true,
        )
        assert.equal(
          s.task({ key: 'work' }).replies!.find(reply => reply.id === 'held')!.state,
          'delivery_unknown',
        )
        await pnyx.restart()
        assert.equal(
          pnyx[harness].sessions.filter(session => session.cwd === folder).length,
          openings,
        )
        assert.equal(
          pausedDeclaration({ card: s.task({ key: 'work' }) })?.hold,
          true,
        )
        assert.equal(
          s.received({ cwd: folder }).length,
          received,
        )
        assert.equal(
          s.task({ key: 'work' }).steering![1]!.attempts.length,
          0,
        )
        await s.owner({
          args: [
            'task',
            'detach',
            'work',
          ],
        })
        await s.owner({
          args: [
            'task',
            'status',
            'work',
            'working',
            '--note',
            'Owner resumes with a replacement',
          ],
        })
        await s.owner({
          args: [
            'task',
            'start',
            'work',
            '--harness',
            harness,
            '--folder',
            folder,
          ],
        })
        const replacement = await s.agent({ cwd: folder })
        const notice = steeringNotice({
          task: s.task({ key: 'work' }).id,
          hydraId: s.hydraId,
          ids: ['held'],
        })
        await until({
          what: 'replacement receives retained ID',
          check: () => replacement.received.includes(notice),
        })
        assert.equal(
          original.received.length,
          received,
        )
        assert.equal(
          await worker.refused({
            args: [
              'task',
              'inbox',
              'read',
              'work',
            ],
          }),
          'STALE_CLAIM',
        )
        const card = s.task({ key: 'work' })
        await s.as({ agent: replacement }).run({
          args: [
            'task',
            'inbox',
            'ack',
            'work',
            'held',
            '--session',
            card.sessionIds![0]!,
            '--generation',
            String(card.steeringGeneration),
          ],
        })
        assert.equal(
          s.task({ key: 'work' }).steering![1]!.ack!.outcome,
          'incorporated',
        )
      } finally {
        held.release()
      }
    },
  )
}

test(
  'Codex carries a rejected steer with the same durable identity into its next turn',
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
    const agent = await s.agent({ cwd: folder })
    await until({
      what: 'opening turn finishes',
      check: () => s.task({ key: 'work' }).sessionActivity === 'finished',
    })
    const notice = ({ id }: { id: string }) => steeringNotice({
      task: s.task({ key: 'work' }).id,
      hydraId: s.hydraId,
      ids: [id],
    })
    const held = pnyx.codex.plan({
      text: notice({ id: 'busy' }),
      hold: true,
    })

    try {
      await s.owner({
        args: [
          'reply',
          'work',
          '--idempotency-key',
          'busy',
          '--text',
          'Keep working',
        ],
      })
      await until({
        what: 'held Codex turn',
        check: () => agent.received.includes(notice({ id: 'busy' })),
      })
      pnyx.codex.plan({
        text: notice({ id: 'carried' }),
        fail: 'Turn already ending',
      })
      await s.owner({
        args: [
          'reply',
          'work',
          '--idempotency-key',
          'carried',
          '--text',
          'Handle next',
        ],
      })
      await until({
        what: 'rejected steer attempted',
        check: () => agent.requests!.includes('turn/steer'),
      })
      held.release()
      await until({
        what: 'carried steer starts a turn',
        check: () => agent.received.filter(text => text === notice({ id: 'carried' })).length === 2 && s.task({ key: 'work' }).sessionActivity === 'finished',
      })
      assert.deepEqual(
        s.task({ key: 'work' }).steering!.map(message => message.id),
        [
          'busy',
          'carried',
        ],
      )
      assert.equal(
        s.task({ key: 'work' }).steering!.filter(message => !message.ack).length,
        2,
      )
    } finally {
      held.release()
    }
  },
)

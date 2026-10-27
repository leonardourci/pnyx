import assert from 'node:assert/strict'
import { test } from 'node:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { steeringNotice } from '../../src/task-inbox/notice.ts'
import { openPage, scenarioGroup, until } from '../../src/test-harness/harness.ts'

const pnyx = scenarioGroup()

test(
  'an acknowledged queued notice is discarded without leaving the worker busy',
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
      ],
    })
    const agent = await s.agent({ cwd: folder })
    const worker = s.as({ agent })
    await until({
      what: 'opening turn finishes',
      check: () => s.task({ key: 'work' }).sessionActivity === 'finished',
    })
    const notice = ({ id }: { id: string }) => steeringNotice({
      task: s.task({ key: 'work' }).id,
      hydraId: s.hydraId,
      ids: [id],
    })
    const held = pnyx.claude.plan({
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
          'Busy instruction',
        ],
      })
      await until({
        what: 'busy turn receives input',
        check: () => agent.received.includes(notice({ id: 'busy' })),
      })
      await s.owner({
        args: [
          'reply',
          'work',
          '--idempotency-key',
          'queued',
          '--text',
          'Read through the inbox before its notice arrives',
        ],
      })
      assert.equal(
        agent.received.includes(notice({ id: 'queued' })),
        false,
      )
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
        /Read through the inbox/,
      )
      const card = s.task({ key: 'work' })

      for (const id of [
        'busy',
        'queued',
      ]) {
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
      }

      held.release()
      await until({
        what: 'worker finishes after skipping acknowledged notice',
        check: () => s.task({ key: 'work' }).sessionActivity === 'finished',
      })
      assert.equal(
        agent.received.includes(notice({ id: 'queued' })),
        false,
      )
      assert.equal(
        s.events().filter(event => event.type === 'task.steering.handled').length,
        2,
      )
    } finally {
      held.release()
    }
  },
)

test(
  'a hold drops a queued notice and release notifies its still-pending ID',
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
      ],
    })
    const agent = await s.agent({ cwd: folder })
    const worker = s.as({ agent })
    await until({
      what: 'opening turn finishes',
      check: () => s.task({ key: 'work' }).sessionActivity === 'finished',
    })
    const notice = ({ id }: { id: string }) => steeringNotice({
      task: s.task({ key: 'work' }).id,
      hydraId: s.hydraId,
      ids: [id],
    })
    const held = pnyx.claude.plan({
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
          'Working',
        ],
      })
      await until({
        what: 'busy turn receives input',
        check: () => agent.received.includes(notice({ id: 'busy' })),
      })
      const card = s.task({ key: 'work' })
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
          'busy',
          '--session',
          card.sessionIds![0]!,
          '--generation',
          String(card.steeringGeneration),
        ],
      })
      await s.owner({
        args: [
          'reply',
          'work',
          '--idempotency-key',
          'owed',
          '--text',
          'Instruction remains owed',
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
      held.release()
      await until({
        what: 'held turn finishes without consuming owed notice',
        check: () => s.task({ key: 'work' }).sessionActivity === 'finished',
      })
      assert.equal(
        agent.received.includes(notice({ id: 'owed' })),
        false,
      )
      await worker.run({
        args: [
          'task',
          'status',
          'work',
          'working',
          '--note',
          'Resume after hold',
        ],
      })
      await until({
        what: 'release replays dropped notice',
        check: () => agent.received.includes(notice({ id: 'owed' })),
      })
      assert.equal(
        s.task({ key: 'work' }).steering!.find(message => message.id === 'owed')!.ack,
        undefined,
      )
    } finally {
      held.release()
    }
  },
)

for (const harness of [
  'claude',
  'codex',
] as const) {
  test(
    `${harness}: native commands stay direct and selected skills are resolved before durable enqueue`,
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
      const agent = await s.agent({ cwd: folder })
      await until({
        what: 'opening turn finishes',
        check: () => s.task({ key: 'work' }).sessionActivity === 'finished',
      })
      const reference = ({ value }: { value: Record<string, string> }) => `[@/selected](pnyx-skill:${encodeURIComponent(JSON.stringify(value))})`
      await s.owner({
        args: [
          'reply',
          'work',
          '--idempotency-key',
          'command',
          '--text',
          reference({
            value: {
              name: 'compact',
              command: '/compact',
            },
          }),
        ],
      })
      await until({
        what: 'native command reaches provider directly',
        check: () => agent.received.includes('/compact') && s.task({ key: 'work' }).sessionActivity === 'finished',
      })
      assert.equal(
        s.task({ key: 'work' }).steering,
        undefined,
      )
      const skill = join(
        folder,
        'SKILL.md',
      )
      writeFileSync(
        skill,
        'Read the task and checkpoint the instruction.\n',
      )
      await s.owner({
        args: [
          'reply',
          'work',
          '--idempotency-key',
          'skill',
          '--text',
          reference({
            value: {
              name: 'check',
              file: skill,
            },
          }),
        ],
      })
      const notice = steeringNotice({
        task: s.task({ key: 'work' }).id,
        hydraId: s.hydraId,
        ids: ['skill'],
      })
      await until({
        what: 'skill instruction inbox notice',
        check: () => agent.received.includes(notice),
      })
      const payload = s.task({ key: 'work' }).steering![0]!.text
      assert.match(
        payload,
        /Read and follow the skill "check"/,
      )
      assert.equal(
        payload.includes(skill),
        true,
      )
      assert.equal(
        payload.includes('pnyx-skill:'),
        false,
      )
      const read = await s.as({ agent }).run({
        args: [
          'task',
          'inbox',
          'read',
          'work',
        ],
      })
      assert.equal(
        read.includes(skill),
        true,
      )
    },
  )

  test(
    `${harness}: attaching a busy hosted session replays only its new task inbox and fences late output`,
    async () => {
      const s = await pnyx.scenario()
      const folder = s.folder({ name: 'worker' })
      await s.owner({
        args: [
          'task',
          'create',
          '--key',
          'source',
          '--title',
          'Source',
          '--folder',
          folder,
        ],
      })
      await s.owner({
        args: [
          'task',
          'create',
          '--key',
          'target',
          '--title',
          'Target',
          '--folder',
          folder,
        ],
      })
      await s.owner({
        args: [
          'task',
          'start',
          'source',
          '--harness',
          harness,
        ],
      })
      const original = await s.agent({ cwd: folder })
      await until({
        what: 'source opening turn finishes',
        check: () => s.task({ key: 'source' }).sessionActivity === 'finished',
      })
      const sourceNotice = steeringNotice({
        task: s.task({ key: 'source' }).id,
        hydraId: s.hydraId,
        ids: ['busy'],
      })
      const held = pnyx[harness].plan({
        text: sourceNotice,
        hold: true,
        reply: 'OLD TASK OUTPUT',
      })
      const targetNotice = steeringNotice({
        task: s.task({ key: 'target' }).id,
        hydraId: s.hydraId,
        ids: ['target-owed'],
      })
      const page = await openPage({
        port: pnyx.port(),
        hydraId: s.hydraId,
      })

      try {
        await s.owner({
          args: [
            'reply',
            'source',
            '--idempotency-key',
            'busy',
            '--text',
            'Source busy',
          ],
        })
        await until({
          what: 'source is busy',
          check: () => original.received.includes(sourceNotice),
        })
        await s.owner({
          args: [
            'task',
            'inbox',
            'enqueue',
            'source',
            'source-owed',
            '--text',
            'Source pending instruction',
          ],
        })
        await s.owner({
          args: [
            'task',
            'inbox',
            'enqueue',
            'target',
            'target-owed',
            '--text',
            'Target pending instruction',
          ],
        })
        pnyx[harness].plan({
          text: targetNotice,
          reply: 'NEW TASK OUTPUT',
        })
        await s.owner({
          args: [
            'task',
            'attach',
            'target',
            '--session',
            s.task({ key: 'source' }).sessionIds![0]!,
          ],
        })
        const replacement = await until({
          what: 'target has a new hosted opening',
          check: () => {
            const sessions = pnyx[harness].sessions.filter(session => session.cwd === folder)

            return sessions.length > 1 ? sessions.at(-1) : false
          },
        })
        await until({
          what: 'attachment alone notifies target',
          check: () => replacement.received.includes(targetNotice)
        && s.task({ key: 'target' }).sessionActivity === 'finished',
        })
        assert.equal(
          replacement.env.PNYX_ACTOR,
          `worker:${s.task({ key: 'target' }).id}`,
        )
        assert.equal(
          replacement.received.some(text => text.includes('source-owed')),
          false,
        )
        assert.deepEqual(
          s.task({ key: 'source' }).steering!.filter(message => !message.ack).map(message => message.id),
          [
            'busy',
            'source-owed',
          ],
        )
        const through = s.events().at(-1)!.seq
        held.release()
        await s.owner({
          args: [
            'task',
            'show',
            'target',
          ],
        })
        assert.equal(
          s.task({ key: 'target' }).sessionActivity,
          'finished',
        )
        assert.equal(
          s.events().some(event => event.seq > through && event.type === 'card.pushed'
        && event.data.agent?.sessionId === original.id),
          false,
        )

        if (harness === 'claude') {
          const response = await page.command({
            name: 'thread',
            args: [s.task({ key: 'target' }).id],
          }) as { thread: { entries: { text?: string }[] } }
          assert.equal(
            response.thread.entries.some(entry => entry.text?.includes('OLD TASK OUTPUT')),
            false,
          )
        }
      } finally {
        held.release(); page.close()
      }
    },
  )

  test(
    `${harness}: restart does not reopen a hidden task with pending instructions`,
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
      await s.owner({
        args: [
          'task',
          'inbox',
          'enqueue',
          'work',
          'hidden-owed',
          '--text',
          'Pending while hidden',
        ],
      })
      await s.owner({
        args: [
          'task',
          'hide',
          'work',
        ],
      })
      const received = s.received({ cwd: folder }).length
      const openings = pnyx[harness].sessions.filter(session => session.cwd === folder).length
      await pnyx.restart()
      assert.equal(
        s.task({ key: 'work' }).hidden,
        true,
      )
      assert.equal(
        s.received({ cwd: folder }).length,
        received,
      )
      assert.equal(
        pnyx[harness].sessions.filter(session => session.cwd === folder).length,
        openings,
      )
      assert.equal(
        s.task({ key: 'work' }).steering![0]!.ack,
        undefined,
      )
      assert.equal(
        s.task({ key: 'work' }).steering![0]!.attempts.length,
        0,
      )
    },
  )
}

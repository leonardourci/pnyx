import assert from 'node:assert/strict'
import { test } from 'node:test'
import { taskTimeline } from '../../web/src/hydra/task-updates.ts'
import { openPage, scenarioGroup, until } from './harness.ts'

const pnyx = scenarioGroup()

test(
  'a worker asks, Hydra escalates, the owner answers on the page, the worker gets it once, and it stays answered after a restart',
  async () => {
    const s = await pnyx.scenario()
    const folder = s.folder({ name: 'web-app' })
    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'Deslop the web app',
        '--key',
        'ship',
        '--folder',
        folder,
      ],
    })
    await s.owner({
      args: [
        'task',
        'start',
        'ship',
      ],
    })
    const worker = s.as({ agent: await s.agent({ cwd: folder }) })
    const taskId = s.task({ key: 'ship' }).id
    await until({
      what: 'the worker to finish its opening turn',
      check: () => s.task({ key: 'ship' }).sessionActivity === 'finished',
    })
    await worker.run({
      args: [
        'task',
        'status',
        'ship',
        'working',
        '--note',
        'Cleaning up',
      ],
    })
    const id = /^ask: (\S+)$/m.exec(await worker.run({
      args: [
        'task',
        'ask',
        'ship',
        '--question',
        'Delete the legacy theme?',
        '--choice',
        'Delete',
        '--choice',
        'Keep',
      ],
    }))![1]!
    assert.equal(
      s.task({ key: 'ship' }).column,
      s.column({ role: 'in_progress' }),
    )

    // The question wakes Hydra, which hands it to the owner under the same id.
    const hydraAgent = await s.agent({ hydra: true })
    await until({
      what: 'Hydra to hear the question',
      check: () => hydraAgent.received.some(text => text.includes('Delete the legacy theme?')),
    })
    const hydra = s.as({ agent: hydraAgent })
    assert.equal(
      await worker.refused({
        args: [
          'task',
          'escalate',
          'ship',
          id,
          '--reason',
          'I want the owner',
        ],
      }),
      'NOT_ALLOWED',
    )
    assert.equal(
      await hydra.refused({
        args: [
          'task',
          'escalate',
          'ship',
          id,
        ],
      }),
      'VALIDATION_ERROR',
    )
    await hydra.run({
      args: [
        'task',
        'escalate',
        'ship',
        id,
        '--question',
        'Can the legacy theme go?',
        '--reason',
        'it is user-visible',
      ],
    })

    const page = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })
    const ask = await page.shows({
      what: 'the escalated question in Needs you',
      check: ({ state }) => {
        const card = state.cards[taskId]

        return card?.column === s.column({ role: 'needs_you' }) && card.asks?.find(a => a.id === id && a.escalated)
      },
    })
    assert.deepEqual(
      [
        ask.question,
        ask.actor,
        ask.audience,
        ask.escalated?.question,
        ask.escalated?.actor,
        ask.escalated?.reason,
      ],
      [
        'Delete the legacy theme?',
        `worker:${taskId}`,
        'owner',
        'Can the legacy theme go?',
        'hydra',
        'it is user-visible',
      ],
    )
    assert.equal(
      s.events().find(e => e.type === 'task.asked')?.actor,
      `worker:${taskId}`,
    )

    // Only the owner answers it now, and a worker cannot pass for the page.
    for (const [
      agent,
      args,
      code,
    ] of [
        [
          hydra,
          [
            'answer',
            'ship',
            id,
            '--choice',
            '1',
            '--reason',
            'obvious',
          ],
          'OWNER_ONLY',
        ],
        [
          hydra,
          [
            'escalate',
            'ship',
            id,
            '--reason',
            'again',
          ],
          'ASK_CLOSED',
        ],
        [
          worker,
          [
            'answer',
            'ship',
            id,
            '--choice',
            '1',
            '--actor',
            'web',
          ],
          'NOT_ALLOWED',
        ],
      ] as const) {
      assert.equal(
        await agent.refused({
          args: [
            'task',
            ...args,
          ],
        }),
        code,
      )
    }

    // The page answers through the server, whose own environment may carry a worker's actor.
    process.env.PNYX_ACTOR = `worker:${taskId}`

    try {
      assert.equal(
        (await page.command({
          name: 'task',
          args: [
            'answer',
            taskId,
            id,
            '--text',
            'Keep it one more release.',
          ],
        })).state,
        'delivered',
      )
    } finally {
      delete process.env.PNYX_ACTOR
    }

    assert.equal(
      s.events().findLast(e => e.type === 'card.replied' && e.data.answers === id)?.actor,
      'web',
    )
    const answers = () => s.received({ cwd: folder }).filter(text => text.includes('Keep it one more release.'))
    await until({
      what: 'the worker to get the answer',
      check: () => answers().length > 0,
    })
    assert.match(
      answers().join('\n---\n'),
      /^Answer from the owner to your question .*: Delete the legacy theme\?\nKeep it one more release\.$/,
    )
    await page.shows({
      what: 'the task back in progress',
      check: ({ state }) => state.cards[taskId]?.column === s.column({ role: 'in_progress' }),
    })
    const card = s.task({ key: 'ship' })
    const decision = taskTimeline({
      card,
      events: s.events().filter(e => e.cardId === taskId)
        .map(e => ({
          ...e,
          summary: '',
          data: e.data as Record<string, unknown>,
        })),
      columns: s.state().config!.columns,
    }).find(u => u.id === id)!.decision!
    assert.deepEqual(
      [
        decision.actor,
        decision.answer,
        decision.choice,
        decision.ask?.escalation?.question,
      ],
      [
        'You',
        'Keep it one more release.',
        undefined,
        'Can the legacy theme go?',
      ],
    )
    page.close()

    await pnyx.restart()
    const after = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })
    await after.shows({
      what: 'the question still answered after the restart',
      check: ({ state }) => state.cards[taskId]?.asks?.find(a => a.id === id)?.answered,
    })
    assert.equal(
      await s.ownerRefused({
        args: [
          'task',
          'answer',
          'ship',
          id,
          '--text',
          'Delete it after all.',
        ],
      }),
      'ASK_CLOSED',
    )
    // A later message reaches the resumed worker; by then any repeat of the answer would have too.
    await s.owner({
      args: [
        'reply',
        taskId,
        '--text',
        'Thanks, carry on.',
      ],
    })
    await until({
      what: 'the resumed worker to get the next message',
      check: () => s.received({ cwd: folder }).at(-1) === 'Thanks, carry on.',
    })
    assert.equal(
      answers().length,
      1,
    )
    after.close()
  },
)

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { taskTimeline } from '../../web/src/hydra/task-updates.ts'
import { openPage, scenarioGroup, until } from './harness.ts'

const pnyx = scenarioGroup()

test(
  'Hydra creates and starts a task only with a reason, a start repeated with its event id runs one worker, the worker’s declarations place its card, needs_you and blocked wake Hydra, and the card reads the same after a restart',
  async () => {
    const s = await pnyx.scenario()
    const folder = s.folder({ name: 'mobile' })
    const hydraAgent = await s.chat({ text: 'Fix the login crash on mobile.' })
    const hydra = s.as({ agent: hydraAgent })
    const create = [
      'task',
      'create',
      '--title',
      'Login crash',
      '--key',
      'crash',
      '--folder',
      folder,
    ]
    assert.equal(
      (await hydra.refusal({ args: create })).error,
      'Hydra changes need --reason <why>',
    )
    await hydra.run({
      args: [
        ...create,
        '--reason',
        'the owner reported the crash',
      ],
    })
    assert.equal(
      s.task({ key: 'crash' }).column,
      s.column({ role: 'queued' }),
    )
    assert.equal(
      await hydra.refused({
        args: [
          'task',
          'start',
          'crash',
        ],
      }),
      'VALIDATION_ERROR',
    )

    const start = [
      'task',
      'start',
      'crash',
      '--reason',
      'it is ready to work on',
      '--event-id',
      'start-crash',
    ]
    await hydra.run({ args: start })
    await hydra.run({ args: start })
    const agent = await s.agent({ cwd: folder })
    await until({
      what: 'the worker to finish its opening turn',
      check: () => s.task({ key: 'crash' }).sessionActivity === 'finished',
    })
    const card = s.task({ key: 'crash' })
    assert.deepEqual(
      [
        s.received({ cwd: folder }).length,
        card.agent?.sessionId,
        card.column,
        card.status?.state,
        s.events().find(e => e.type === 'task.created')?.reason,
        agent.env.PNYX_ACTOR,
      ],
      [
        1,
        agent.id,
        s.column({ role: 'in_progress' }),
        'working',
        'the owner reported the crash',
        `worker:${card.id}`,
      ],
    )
    assert.match(
      agent.received[0]!,
      new RegExp(`You are the Pnyx worker for task ${card.id} "Login crash" on Hydra ${s.hydraId}\\. Follow the pnyx-report-progress skill`),
    )

    const worker = s.as({ agent })

    const declare = async ({
      state,
      flags,
      role,
      wakes = false,
    }: {
      state: string
      flags: string[]
      role: string
      wakes?: boolean
    }) => {
      const heard = hydraAgent.received.length
      await worker.run({
        args: [
          'task',
          'status',
          'crash',
          state,
          ...flags,
        ],
      })
      assert.equal(
        s.task({ key: 'crash' }).column,
        s.column({ role }),
        `${state} ${flags.join(' ')}`,
      )

      if (wakes) {
        await until({
          what: `Hydra to wake for ${state}`,
          check: () => hydraAgent.received.slice(heard).some(text => text.startsWith('<pnyx-wake>')),
        })
      }
    }

    await declare({
      state: 'needs_you',
      flags: [
        '--note',
        'Which crash report is current?',
      ],
      role: 'in_progress',
      wakes: true,
    })
    await declare({
      state: 'blocked',
      flags: [
        '--note',
        'No simulator license',
      ],
      role: 'in_progress',
      wakes: true,
    })
    await declare({
      state: 'paused',
      flags: ['--hold'],
      role: 'parked',
    })
    await declare({
      state: 'working',
      flags: [
        '--note',
        'Reproduced it',
      ],
      role: 'in_progress',
    })
    await pnyx.restart()
    const page = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })
    const after = await page.shows({
      what: 'the restarted server to show the card',
      check: ({ state }) => state.cards[card.id],
    })
    page.close()
    assert.deepEqual(
      [
        after.status?.state,
        after.status?.note,
        after.column,
      ],
      [
        'working',
        'Reproduced it',
        s.column({ role: 'in_progress' }),
      ],
    )
  },
)

test(
  'a worker’s question goes to Hydra, which answers it itself or escalates it and records the owner’s answer from its chat, and each answer reaches the worker once',
  async () => {
    const s = await pnyx.scenario()
    const folder = s.folder({ name: 'api' })
    const hydraAgent = await s.chat({ text: 'Add pagination to the API.' })
    const hydra = s.as({ agent: hydraAgent })
    await hydra.run({
      args: [
        'task',
        'create',
        '--title',
        'Pagination',
        '--key',
        'pages',
        '--folder',
        folder,
        '--reason',
        'the owner asked for it',
      ],
    })
    await hydra.run({
      args: [
        'task',
        'start',
        'pages',
        '--reason',
        'the owner asked for it',
      ],
    })
    const worker = s.as({ agent: await s.agent({ cwd: folder }) })

    const ask = async ({ question }: { question: string }) => {
      const heard = hydraAgent.received.length
      const output = await worker.run({
        args: [
          'task',
          'ask',
          'pages',
          '--question',
          question,
          '--choice',
          'Cursor',
          '--choice',
          'Offset',
        ],
      })
      const id = /^ask: (\S+)$/m.exec(output)![1]!
      await until({
        what: 'Hydra to hear the question',
        check: () => hydraAgent.received.slice(heard).some(text => text.includes(question)),
      })

      return id
    }

    const answers = ({ id }: { id: string }) => s.received({ cwd: folder }).filter(text => text.includes(`to your question ${id}:`))

    const style = await ask({ question: 'Cursor or offset pagination?' })
    assert.equal(
      s.task({ key: 'pages' }).column,
      s.column({ role: 'in_progress' }),
    )
    await hydra.run({
      args: [
        'task',
        'answer',
        'pages',
        style,
        '--choice',
        '1',
        '--reason',
        'the API already uses cursors',
      ],
    })
    await until({
      what: 'the worker to get Hydra’s answer',
      check: () => answers({ id: style }).length > 0,
    })
    assert.equal(
      answers({ id: style })[0],
      `Answer from Hydra to your question ${style}: Cursor or offset pagination?\nChoice: Cursor`,
    )

    const size = await ask({ question: 'Default page size?' })

    const say = async ({ text }: { text: string }) => {
      const output = await s.owner({
        args: [
          'hydra',
          'send',
          '--text',
          text,
        ],
      })

      return /^message: (\S+)$/m.exec(output)![1]!
    }

    const early = await say({ text: 'Keep the defaults.' })
    await hydra.run({
      args: [
        'task',
        'escalate',
        'pages',
        size,
        '--reason',
        'page size is a product call',
      ],
    })
    assert.equal(
      s.task({ key: 'pages' }).column,
      s.column({ role: 'needs_you' }),
    )
    const relay = ({ message }: { message: string }) => [
      'task',
      'answer',
      'pages',
      size,
      '--from-message',
      message,
      '--reason',
      'the owner answered in the chat',
    ]
    // Only what the owner said after the question reached them answers it.
    assert.equal(
      await hydra.refused({ args: relay({ message: early }) }),
      'VALIDATION_ERROR',
    )
    const answerMessage = await say({ text: 'Use 50 per page.' })
    await hydra.run({
      args: relay({ message: answerMessage }),
    })
    await until({
      what: 'the worker to get the owner’s answer',
      check: () => answers({ id: size }).length > 0,
    })
    assert.equal(
      answers({ id: size })[0],
      `Answer from the owner to your question ${size}: Default page size?\nUse 50 per page.`,
    )
    assert.equal(
      await s.ownerRefused({
        args: [
          'task',
          'answer',
          'pages',
          size,
          '--text',
          'Make it 100.',
        ],
      }),
      'ASK_CLOSED',
    )
    const recorded = s.task({ key: 'pages' }).asks?.find(a => a.id === size)
    assert.deepEqual(
      [
        answers({ id: style }).length,
        answers({ id: size }).length,
        s.task({ key: 'pages' }).asks?.map(a => Boolean(a.answered)),
        recorded?.fromMessage?.id,
        recorded?.fromMessage?.text,
        Boolean(recorded?.answeredAt),
      ],
      [
        1,
        1,
        [
          true,
          true,
        ],
        answerMessage,
        'Use 50 per page.',
        true,
      ],
    )

    const page = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })
    const shown = await page.shows({
      what: 'the task',
      check: ({ state }) => state,
    })
    const card = s.task({ key: 'pages' })
    const history = await page.command({
      name: 'history',
      args: [
        '--card',
        card.id,
        '--full',
        '--updates',
      ],
    })
    const decisions = taskTimeline({
      card: shown.cards[card.id]!,
      events: history.events as Parameters<typeof taskTimeline>[0]['events'],
      columns: shown.config!.columns,
    }).filter(u => u.decision)
      .map(u => [
        u.id,
        u.decision!.actor,
        u.decision!.answer,
      ])
    page.close()
    assert.deepEqual(
      decisions.sort(),
      [
        [
          size,
          'You',
          'Use 50 per page.',
        ],
        [
          style,
          'Hydra',
          'Cursor',
        ],
      ].sort(),
    )
  },
)

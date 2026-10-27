import { REPORT_PROGRESS_SKILL } from '../../src/integrations/skills/names.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
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
      new RegExp(`You are the Pnyx worker for task ${card.id} "Login crash" on Hydra ${s.hydraId}\\. Follow the ${REPORT_PROGRESS_SKILL} skill`),
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

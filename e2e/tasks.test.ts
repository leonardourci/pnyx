import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { taskReadiness } from '#tasks/dependencies.ts'
import { hydraDigest } from '#hydra/digest.ts'
import { boardReview } from '#hydra/review.ts'
import type { HydraState } from '#app/model.ts'
import { cardStatus, currentState, statusLabel, waitingQuestions } from '#tasks/card-status.ts'
import { openPage, until } from '#test-harness/harness.ts'
import { pnyx } from '#test-harness/pnyx.ts'

function followsProject({ prompt }: { prompt: string }): void {
  assert.match(
    prompt,
    /Before changing anything/,
  )

  for (const path of [
    'AGENTS.md',
    'CLAUDE.md',
    'CONTRIBUTING.md',
    '.agents/skills',
    '.claude/skills',
    'skills/',
  ]) {
    assert.ok(
      prompt.includes(path),
      `opening prompt names ${path}`,
    )
  }

  assert.match(
    prompt,
    /Follow them over generic habits/,
  )
  assert.match(
    prompt,
    /use the project's skills for the jobs they cover/,
  )
}

test(
  'task life: Hydra creates and starts a task only with a reason, a repeated start runs one worker with the project conventions, its declarations place and wake, its own question gets the owner’s answer once, Done, the session hands off to the next task, and the card survives a restart',
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
      '--brief',
      'Fix the parser.',
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
      '--prompt',
      'Start with the failing input.',
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
    assert.ok(agent.received[0]!.startsWith(`<pnyx-worker task="${card.id}" hydra="${s.hydraId}">`))
    followsProject({ prompt: agent.received[0]! })
    assert.ok(agent.received[0]!.includes('Fix the parser.'))
    assert.ok(agent.received[0]!.endsWith('Start with the failing input.'))

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
    // The worker's own question gets the owner's answer, once.
    const asked = await worker.run({
      args: [
        'task',
        'ask',
        'crash',
        '--question',
        'Keep the old crash format?',
        '--choice',
        'Keep',
        '--choice',
        'Drop',
      ],
    })
    const ask = /^ask: (\S+)$/m.exec(asked)![1]!
    await s.owner({
      args: [
        'task',
        'answer',
        'crash',
        ask,
        '--choice',
        'Keep',
      ],
    })
    const answers = () => agent.received.filter(text => text.includes(`your question ${ask}`))
    await until({
      what: 'the worker to get the answer',
      check: () => answers().length > 0,
    })
    assert.equal(
      answers().length,
      1,
    )
    assert.match(
      answers()[0]!,
      /Choice: Keep/,
    )
    await declare({
      state: 'done',
      flags: [],
      role: 'done',
    })
    // The finished worker's session takes the next task, and the handoff carries the conventions again.
    await s.owner({
      args: [
        'task',
        'create',
        '--key',
        'next',
        '--title',
        'Next assignment',
        '--brief',
        'Document the parser.',
        '--folder',
        folder,
      ],
    })
    await s.owner({
      args: [
        'task',
        'attach',
        'next',
        '--session',
        card.sessionIds![0]!,
      ],
    })
    const handoff = s.task({ key: 'next' }).steering?.find(message => message.text.includes('Document the parser.'))?.text
    assert.ok(
      handoff?.startsWith(`<pnyx-worker task="${s.task({ key: 'next' }).id}"`),
      handoff,
    )
    followsProject({ prompt: handoff! })
    assert.equal(
      s.task({ key: 'next' }).agent?.sessionId,
      agent.id,
    )

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
        after.column,
      ],
      [
        'done',
        s.column({ role: 'done' }),
      ],
    )
  },
)

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

test(
  'a card carries its Intent, follows the worker\'s newest words and asks you to merge',
  async () => {
    const s = await pnyx.scenario()
    const app = await s.project({ name: 'card-context-app' })
    const intent = 'You want unknown pages to go to their Hydra\'s home instead of breaking the page.'
    const create = ({ value }: { value: string }) => [
      'task',
      'create',
      '--title',
      'Refused intent',
      '--intent',
      value,
    ]

    for (const value of [
      ' \n ',
      'x'.repeat(4001),
    ]) {
      assert.equal(
        await s.ownerRefused({ args: create({ value }) }),
        'VALIDATION_ERROR',
      )
    }

    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'Redirect unknown pages',
        '--key',
        'redirect',
        '--project',
        app,
        '--intent',
        intent,
      ],
    })
    const page = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })
    const card = ({ state }: { state: HydraState }) => state.cards[s.task({ key: 'redirect' }).id]

    try {
      await page.shows({
        what: 'the Intent on the card',
        check: ({ state }) => card({ state })?.intent === intent,
      })
      assert.match(
        await s.owner({
          args: [
            'task',
            'show',
            'redirect',
          ],
        }),
        /intent: .*unknown pages/,
      )
      await s.owner({
        args: [
          'task',
          'start',
          'redirect',
        ],
      })
      const redirect = s.task({ key: 'redirect' })
      const worker = s.as({ agent: await s.agent({ cwd: redirect.copy!.path }) })
      await worker.run({
        args: [
          'task',
          'status',
          'redirect',
          'working',
          '--note',
          'Checking what an unknown address does today.',
        ],
      })
      await page.shows({
        what: 'the worker\'s note as the current state',
        check: ({ state }) => currentState({ card: card({ state })! })?.text === 'Checking what an unknown address does today.',
      })
      const progress = {
        text: 'Redirect built; opening the pull request next.',
        source: 'progress',
      }
      await worker.run({
        args: [
          'hydra',
          'send',
          '--task',
          'redirect',
          '--kind',
          'progress',
          '--text',
          progress.text,
        ],
      })
      await page.shows({
        what: 'the newer progress report as the current state',
        check: ({ state }) => {
          const said = currentState({ card: card({ state })! })

          return said?.text === progress.text && said.source === progress.source
        },
      })
      const url = s.pullRequest({
        number: 147,
        title: 'Redirect unknown pages to their Hydra\'s home',
        checks: '4 passed, 0 failed, 4 total',
      })
      await worker.run({
        args: [
          'link',
          'redirect',
          '--url',
          url,
        ],
      })
      await page.shows({
        what: 'the merge question reading Needs you',
        check: ({ state }) => {
          const task = card({ state })!
          const merge = task.asks?.filter(ask => ask.kind === 'merge').map(ask => ask.id) ?? []

          return merge.length === 1
            && waitingQuestions({ card: task }).map(question => question.ask?.id)
              .join() === merge.join()
            && statusLabel({ status: cardStatus({ card: task }) }) === 'Needs you'
        },
      })
      assert.deepEqual(
        currentState({ card: s.task({ key: 'redirect' }) }),
        {
          ...progress,
          at: s.task({ key: 'redirect' }).progress!.at,
        },
        'a pull request link is not the task\'s state',
      )
    } finally {
      page.close()
    }
  },
)

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { taskReadiness } from '#tasks/dependencies.ts'
import { columnCards } from '#tasks/select.ts'
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

const OWNER_NOTES = 'Write commits in English.'
const HYDRA_NOTES = 'Report before pausing.'

function carriesStandingNotes({ prompt }: { prompt: string }): void {
  assert.ok(
    prompt.includes(`Standing worker instructions (defer to the scope and authority above):\n${OWNER_NOTES}\n${HYDRA_NOTES}\n</pnyx-worker>`),
    prompt,
  )
}

test(
  'task life: Hydra creates and starts a task only with a reason, a repeated start runs one worker with the project conventions, its declarations place and wake, its own question gets the owner’s answer once, Done, the session hands off to the next task, the card survives a restart, and Hydra\'s own card refuses task-only commands',
  async t => {
    const s = await pnyx.scenario()
    const folder = s.folder({ name: 'mobile' })
    const hydraAgent = await s.chat({ text: 'Fix the login crash on mobile.' })
    const hydra = s.as({ agent: hydraAgent })
    assert.deepEqual(
      [
        await s.ownerRefused({
          args: [
            'task',
            'hold',
            '$hydra',
            '--reason',
            'discuss first',
          ],
        }),
        await s.ownerRefused({
          args: [
            'task',
            'remind',
            '$hydra',
            'in 1 hour',
          ],
        }),
        await s.ownerRefused({
          args: [
            'task',
            'hide-after',
            '$hydra',
            '24',
          ],
        }),
        await s.ownerRefused({
          args: [
            'task',
            'hide',
            '$hydra',
          ],
        }),
      ],
      [
        'VALIDATION_ERROR',
        'VALIDATION_ERROR',
        'VALIDATION_ERROR',
        'VALIDATION_ERROR',
      ],
    )
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
    assert.deepEqual(
      [
        await s.ownerRefused({
          args: [
            'task',
            'hide-after',
            'crash',
            'soon',
          ],
        }),
        await s.ownerRefused({
          args: [
            'task',
            'hide-after',
            'crash',
            '876001',
          ],
        }),
      ],
      [
        'VALIDATION_ERROR',
        'VALIDATION_ERROR',
      ],
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
    // Owner memory is shared by every flow on this server.
    t.after(() => s.owner({
      args: [
        'owner',
        'worker-notes',
        'forget',
        '--reason',
        'flow finished',
      ],
    }))
    await s.owner({
      args: [
        'owner',
        'worker-notes',
        'set',
        '--text',
        OWNER_NOTES,
        '--reason',
        'every worker needs it',
      ],
    })
    await s.owner({
      args: [
        'hydra',
        'worker-notes',
        'set',
        '--text',
        HYDRA_NOTES,
        '--reason',
        'this Hydra needs it',
      ],
    })
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
    carriesStandingNotes({ prompt: agent.received[0]! })
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
    carriesStandingNotes({ prompt: handoff! })
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
    const declared = s.events().find(event => event.type === 'task.declared' && event.cardId === s.task({ key: 'research' }).id)
    assert.deepEqual(
      [
        s.task({ key: 'research' }).column,
        s.task({ key: 'research' }).updatedAt,
        s.task({ key: 'research' }).updatedSeq,
      ],
      [
        s.column({ role: 'parked' }),
        declared?.at,
        declared?.seq,
      ],
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
    await run({
      args: [
        'task',
        'create',
        '--key',
        'obsolete',
        '--title',
        'Superseded work',
        '--hold',
        '--reason',
        'Discuss before starting',
      ],
    })
    await run({
      args: [
        'task',
        'status',
        'obsolete',
        'done',
        '--note',
        'Superseded',
      ],
    })
    const completed = s.task({ key: 'obsolete' })
    assert.equal(
      completed.column,
      s.column({ role: 'done' }),
    )
    assert.ok(completed.doneAt)
    assert.ok(completed.hold)
    await run({
      args: [
        'task',
        'status',
        'obsolete',
        'paused',
        '--note',
        'Reopened',
      ],
    })
    assert.equal(
      s.task({ key: 'obsolete' }).column,
      s.column({ role: 'queued' }),
    )
    assert.equal(
      await s.ownerRefused({
        args: [
          'task',
          'start',
          'obsolete',
        ],
      }),
      'TASK_HELD',
    )
    await run({
      args: [
        'task',
        'status',
        'obsolete',
        'done',
        '--note',
        'Superseded',
      ],
    })
    await pnyx.restart()
    assert.equal(
      s.task({ key: 'obsolete' }).column,
      s.column({ role: 'done' }),
    )
    assert.ok(s.task({ key: 'obsolete' }).doneAt)
    assert.ok(s.task({ key: 'obsolete' }).hold)
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
  'a card keeps its Intent, follows the worker\'s newest words and shows review readiness',
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
        what: 'the linked change reading Ready for review',
        check: ({ state }) => {
          const task = card({ state })!
          const merge = task.asks?.filter(ask => ask.kind === 'merge').map(ask => ask.id) ?? []

          return merge.length === 1
            && waitingQuestions({ card: task }).map(question => question.ask?.id)
              .join() === merge.join()
            && statusLabel({ status: cardStatus({ card: task }) }) === 'Ready for review'
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
      assert.equal(
        s.task({ key: 'redirect' }).intent,
        intent,
        'notes, progress, a pull request and a question leave the Intent alone',
      )

      const stale = await s.ownerRefusal({
        args: [
          'task',
          'intent',
          'redirect',
          '--text',
          'Also cover retired task links.',
        ],
      })
      assert.equal(
        stale.code,
        'VALIDATION_ERROR',
      )
      assert.match(
        stale.error ?? '',
        /task owner-ask/,
        'the old command points to its new name and never writes the Intent',
      )
      await s.owner({
        args: [
          'task',
          'owner-ask',
          'redirect',
          '--text',
          'Also cover retired task links.',
        ],
      })
      assert.equal(
        s.task({ key: 'redirect' }).ask?.at(-1)?.text,
        'Also cover retired task links.',
      )
      assert.equal(
        s.task({ key: 'redirect' }).intent,
        intent,
      )

      const hydra = s.as({ agent: await s.chat({ text: 'Also send links to retired tasks to their Hydra\'s home.' }) })
      const widened = 'You want unknown pages and links to retired tasks to go to their Hydra\'s home instead of breaking the page.'
      const rewrite = ({ value }: { value?: string }) => [
        'task',
        'brief',
        'redirect',
        ...(value === undefined ? [] : [
          '--intent',
          value,
        ]),
        '--reason',
        'the owner widened the scope to retired task links',
      ]

      for (const value of [
        undefined,
        ' ',
      ]) {
        assert.equal(
          (await hydra.refusal({ args: rewrite({ value }) })).code,
          'VALIDATION_ERROR',
        )
      }

      await hydra.run({ args: rewrite({ value: widened }) })
      await page.shows({
        what: 'the rewritten Intent on the card',
        check: ({ state }) => card({ state })?.intent === widened,
      })
      assert.match(
        await s.owner({
          args: [
            'task',
            'show',
            'redirect',
          ],
        }),
        /intent: .*retired tasks/,
      )
      assert.deepEqual(
        s.events().flatMap(event => event.cardId === redirect.id
          && (event.type === 'task.created' || event.type === 'task.brief') && event.data.intent
          ? [event.data.intent]
          : []),
        [
          intent,
          widened,
        ],
        'the log keeps the earlier Intent',
      )
      assert.match(
        await s.owner({
          args: [
            'history',
            '--card',
            'redirect',
            '--updates',
          ],
        }),
        /Intent updated/,
      )
    } finally {
      page.close()
    }
  },
)

test(
  'two starts of one task while its copy is prepared leave one session, in the copy the task records',
  async t => {
    const s = await pnyx.scenario()
    const path = await s.project({ name: 'race' })
    const gates = mkdtempSync(join(
      tmpdir(),
      'pnyx-start-race-',
    ))
    t.after(() => rmSync(
      gates,
      {
        recursive: true,
        force: true,
      },
    ))
    // Each copy announces itself, then waits for its own gate before printing its folder.
    await s.owner({
      args: [
        'project',
        'set',
        'race',
        '--copy',
        `d=$(mktemp -d "${gates}/copy-XXXXXX"); touch "${gates}/entered-$$"; while [ ! -f "${gates}/go-$$" ]; do sleep 0.05; done; echo "$d"`,
      ],
    })
    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'Race',
        '--key',
        'race',
        '--project',
        path,
      ],
    })

    const start = async () => {
      try {
        await s.owner({
          args: [
            'task',
            'start',
            'race',
            '--harness',
            'claude',
            '--prompt',
            'Start once',
          ],
        })

        return 'started'
      } catch (error) {
        return (error as Error).message
      }
    }

    const starts = [
      start(),
      start(),
    ]
    const entered = () => readdirSync(gates).filter(name => name.startsWith('entered-'))
      .map(name => name.slice('entered-'.length))
    await until({
      what: 'both copies to be under way',
      check: () => entered().length === 2,
    })
    const [
      first,
      second,
    ] = entered()
    writeFileSync(
      join(
        gates,
        `go-${first}`,
      ),
      '',
    )
    await until({
      what: 'the first start to attach its agent',
      check: () => Boolean(s.task({ key: 'race' }).sessionIds?.length),
    })
    writeFileSync(
      join(
        gates,
        `go-${second}`,
      ),
      '',
    )
    const outcomes = await Promise.all(starts)

    assert.equal(
      outcomes.filter(outcome => outcome === 'started').length,
      1,
    )
    assert.match(
      outcomes.find(outcome => outcome !== 'started') ?? '',
      /SESSION_CONFLICT/,
    )
    const task = s.task({ key: 'race' })
    const agent = await s.agent({ cwd: task.copy!.path })
    assert.deepEqual(
      [
        task.folder,
        agent.cwd,
        existsSync(task.copy!.path),
      ],
      [
        task.copy!.path,
        task.copy!.path,
        true,
      ],
    )
    assert.equal(
      s.events().filter(event => event.type === 'task.copy' && event.cardId === task.id).length,
      1,
    )
  },
)

test(
  'a task started through the Hydra command runs it in the task folder and records the launch, and without a command the start is refused',
  async () => {
    const s = await pnyx.scenario()
    const folder = s.folder({ name: 'by-command' })
    await s.owner({
      args: [
        'task',
        'create',
        '--title',
        'Run the Hydra command',
        '--key',
        'by-command',
        '--folder',
        folder,
      ],
    })
    const start = [
      'task',
      'start',
      'by-command',
      '--via',
      'command',
    ]
    assert.equal(
      await s.ownerRefused({ args: start }),
      'NO_COMMAND',
    )
    await s.owner({
      args: [
        'hydra',
        'set',
        '--command',
        'touch "$PNYX_FOLDER/ran"',
      ],
    })
    await s.owner({ args: start })
    await until({
      what: 'the Hydra command to run in the task folder',
      check: () => existsSync(join(
        folder,
        'ran',
      )),
    })
    const card = s.task({ key: 'by-command' })
    assert.deepEqual(
      [
        card.launch?.via,
        card.launch?.command,
        card.status?.state,
      ],
      [
        'command',
        'touch "$PNYX_FOLDER/ran"',
        'working',
      ],
    )
  },
)

test(
  'Continue in Pnyx refuses a task with no outside session, one that may still run or one attached elsewhere, and resumes an ended session in its folder',
  async () => {
    const s = await pnyx.scenario()
    const folder = s.folder({ name: 'outside' })
    const create = ({ key }: { key: string }) => s.owner({
      args: [
        'task',
        'create',
        '--title',
        `Work on ${key}`,
        '--key',
        key,
        '--folder',
        folder,
      ],
    })
    const push = ({
      key,
      activity,
    }: {
      key: string
      activity: string
    }) => s.owner({
      args: [
        'push',
        '--key',
        key,
        '--file',
        '-',
      ],
      input: JSON.stringify({
        agent: {
          provider: 'claude-code',
          sessionId: 'outside-session',
          cwd: folder,
        },
        activity,
      }),
    })
    const refusal = ({ key }: { key: string }) => s.ownerRefusal({
      args: [
        'task',
        'continue',
        key,
      ],
    })
    await create({ key: 'outside' })
    await create({ key: 'plain' })
    await create({ key: 'elsewhere' })
    await push({
      key: 'outside',
      activity: 'working',
    })
    await push({
      key: 'elsewhere',
      activity: 'working',
    })
    assert.deepEqual(
      [
        await refusal({ key: 'plain' }),
        await refusal({ key: 'outside' }),
        await refusal({ key: 'elsewhere' }),
      ],
      [
        {
          code: 'NO_ROUTE',
          error: 'Continue in Pnyx needs an outside Claude Code or Codex session attached to a task',
        },
        {
          code: 'SESSION_RUNNING',
          error: 'cannot confirm the outside session has ended: No process and terminal were recorded.',
        },
        {
          code: 'SESSION_CONFLICT',
          error: 'the session is no longer attached to this task',
        },
      ],
    )

    await push({
      key: 'outside',
      activity: 'ended',
    })
    await s.owner({
      args: [
        'task',
        'continue',
        'outside',
      ],
    })
    assert.deepEqual(
      [
        s.task({ key: 'outside' }).agent?.host,
        s.task({ key: 'outside' }).status?.note,
      ],
      [
        'pnyx',
        'Worker continued in Pnyx',
      ],
    )
    await s.owner({
      args: [
        'reply',
        'outside',
        '--text',
        'Carry on from where you stopped',
      ],
    })
    const resumed = await s.agent({ cwd: folder })
    assert.equal(
      resumed.resumed,
      true,
    )
    assert.match(
      resumed.received[0]!,
      /Carry on from where you stopped/,
    )
  },
)

test(
  'a task created before another keeps that place through a restart, from the CLI and an apply document, and a target outside its column is refused',
  async () => {
    const s = await pnyx.scenario()
    const create = ({
      key,
      flags = [],
    }: {
      key: string
      flags?: string[]
    }) => s.owner({
      args: [
        'task',
        'create',
        '--title',
        key,
        '--key',
        key,
        ...flags,
      ],
    })
    const queued = () => columnCards({
      state: s.state(),
      column: s.column({ role: 'queued' })!,
    }).map(card => card.key)

    await create({ key: 'first' })
    await create({ key: 'last' })
    await create({
      key: 'middle',
      flags: [
        '--before',
        'last',
      ],
    })
    await s.owner({
      args: [
        'apply',
        '--file',
        '-',
      ],
      input: JSON.stringify({
        version: 1,
        changes: [
          {
            op: 'task.create',
            as: 'lead',
            key: 'lead',
            title: 'lead',
            before: 'first',
          },
          {
            op: 'task.create',
            key: 'top',
            title: 'top',
            before: '$lead',
          },
        ],
      }),
    })
    assert.deepEqual(
      queued(),
      [
        'top',
        'lead',
        'first',
        'middle',
        'last',
      ],
    )
    assert.deepEqual(
      await s.ownerRefusal({
        args: [
          'task',
          'create',
          '--title',
          'Elsewhere',
          '--column',
          'in_progress',
          '--before',
          'first',
        ],
      }),
      {
        code: 'VALIDATION_ERROR',
        error: `card first is not in column ${s.column({ role: 'in_progress' })}`,
      },
    )

    await pnyx.restart()
    const page = await openPage({
      port: pnyx.port(),
      hydraId: s.hydraId,
    })

    try {
      const restarted = await page.shows({
        what: 'the restarted server\'s Hydra',
        check: ({ state }) => state,
      })
      assert.deepEqual(
        columnCards({
          state: restarted,
          column: s.column({ role: 'queued' })!,
        }).map(card => card.key),
        [
          'top',
          'lead',
          'first',
          'middle',
          'last',
        ],
      )
    } finally {
      page.close()
    }
  },
)

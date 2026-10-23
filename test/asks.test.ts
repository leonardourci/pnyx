import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { commands } from '../src/cli/commands.ts'
import { sendReply, type ReplyRequest } from '../src/cli/reply.ts'
import { startTask } from '../src/cli/start.ts'
import { workerCommands } from '../src/cli/workers.ts'
import { decideReply } from '../src/core/decide.ts'
import { emptyHydra, replay } from '../src/core/reducer.ts'
import { lifecycleStage } from '../src/core/lifecycle.ts'
import type { Card, HydraEvent } from '../src/core/model.ts'
import { HYDRA_CARD, hydraDelivery, hydraEvent } from '../src/core/hydra.ts'
import { readThread } from '../src/thread/read.ts'
import { hydraMessages, joinMessageParts } from '../web/src/hydra/chat.ts'
import { startServer, type RunningServer } from '../src/server/server.ts'
import { loadHydra, readEvents, withWriter } from '../src/store/hydra-store.ts'
import { taskTimeline } from '../web/src/hydra/task-updates.ts'
import { cardState } from '../web/src/hydra/view.ts'
import { fakeDispatch } from './dispatch-fixture.ts'
import { hydraSdk } from './hydra-host-fixture.ts'

// A worker or Hydra session running these tests must not lend them its actor.
delete process.env.PNYX_ACTOR
delete process.env.PNYX_HYDRA

let server: RunningServer | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
})

async function until({ check }: { check: () => boolean }) {
  for (let i = 0; i < 300; i++) {
    if (check()) {
      return
    }

    await new Promise(resolve => setTimeout(
      resolve,
      10,
    ))
  }

  assert.fail(`timed out waiting for ${check}`)
}

async function lab({ worker = true }: { worker?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(
    tmpdir(),
    'pnyx-asks-',
  )))
  process.env.PNYX_HOME = join(
    root,
    'pnyx',
  )
  process.env.PNYX_SEMANTIC = 'off'
  process.env.CLAUDE_CONFIG_DIR = join(
    root,
    'claude',
  )
  fakeDispatch({ root })
  const folder = join(
    root,
    'work',
  )
  mkdirSync(folder)
  await workerCommands.hydra([
    'create',
    'lab',
    '--hydra',
    'lab',
  ])
  await commands.task([
    'create',
    '--title',
    'Deslop the web app',
    '--key',
    'ship',
    '--folder',
    folder,
    '--hydra',
    'lab',
  ])
  const sdk = hydraSdk()
  server = await startServer({
    hydraId: 'lab',
    query: sdk.query,
    wakeDelay: 50,
  })
  const state = () => loadHydra({ hydraId: 'lab' }).state
  const task = () => state().cards[state().keys.ship!]! as Card
  const role = ({ name }: { name: string }) =>
    state().config?.columns.find(c => c.role === name)?.id

  if (worker) {
    await startTask({
      hydraId: 'lab',
      task: 'ship',
      meta: {
        at: new Date().toISOString(),
        actor: 'cli',
        id: 'start',
      },
    })
    await until({ check: () => task().sessionActivity === 'finished' })
  }

  const run = ({ args }: { args: string[] }) => commands.task([
    ...args,
    '--hydra',
    'lab',
  ]) as Promise<Record<string, unknown>>
  const workerCall = () => sdk.calls.find(call => call.options.cwd === folder)
  const hydraSaid = () => sdk.calls.filter(call => call.options.cwd !== folder)
    .flatMap(call => call.messages)
  // A report reaches Hydra inside the wake that carries its batch.
  const hydraHeard = ({ report }: { report: string }) => hydraSaid()
    .some(text => text.startsWith('<pnyx-wake>') && text.includes(report))
  const events = () => readEvents({ hydraId: 'lab' })
  const timeline = () => taskTimeline({
    card: task(),
    events: events().filter(e => e.cardId === task().id)
      .map(e => ({
        ...e,
        summary: '',
        data: e.data as Record<string, unknown>,
      })),
    columns: state().config!.columns,
  })

  return {
    root,
    sdk,
    state,
    task,
    role,
    run,
    workerCall,
    hydraSaid,
    hydraHeard,
    events,
    timeline,
  }
}

const refused = async ({
  run,
  code,
}: {
  run: () => Promise<unknown>
  code: string
}) => {
  await assert.rejects(
    async () => run(),
    (error: { code?: string }) => error.code === code,
  )
}

test(
  'the worker opening prompt routes a decision into a saved question',
  async () => {
    const f = await lab()
    const call = f.workerCall()
    assert.ok(call)
    const prompt = call.messages[0]
    assert.ok(prompt)
    const command = prompt.match(/`pnyx-axi task (ask [^`]+)`/)?.[1]
    assert.ok(
      command,
      'the opening prompt must give the worker a task ask command',
    )
    const filled = command.replace(
      '<question>',
      'Keep the approved conversation-wide numbering?',
    )
    const words = filled.match(/"[^"]*"|\S+/g)
    assert.ok(words)
    const args = words.map(arg => arg.replace(
      /^"|"$/g,
      '',
    ))
    await commands.task([
      ...args,
      '--actor',
      `worker:${f.task().id}`,
    ])
    const ask = f.task().asks?.[0]
    assert.ok(ask)
    assert.equal(
      ask.question,
      'Keep the approved conversation-wide numbering?',
    )
    assert.equal(
      ask.audience,
      'hydra',
    )
    assert.equal(
      ask.answered,
      undefined,
    )
    await until({ check: () => f.hydraHeard({ report: `Question ${ask.id}:` }) })
  },
)

test(
  'a question needs real words; choices and recommendations must name what exists',
  async () => {
    const f = await lab({ worker: false })
    const worker = `worker:${f.task().id}`
    const ask = ({ args }: { args: string[] }) => f.run({
      args: [
        'ask',
        'ship',
        ...args,
        '--actor',
        worker,
      ],
    })
    const details = join(
      f.root,
      'details.md',
    )
    writeFileSync(
      details,
      'Measured on main.',
    )

    for (const args of [
      [
        '--question',
        '   ',
      ],
      [
        '--question',
        'x'.repeat(301),
      ],
      [
        '--question',
        'Which?',
        '--recommend',
        '1',
      ],
      [
        '--question',
        'Which?',
        '--choice',
        'a',
        '--recommend',
        '2',
      ],
      [
        '--question',
        'Which?',
        '--choice',
        'a',
        '--choice',
        'a',
      ],
      [
        '--question',
        'Which?',
        '--details',
        'x',
        '--details-file',
        details,
      ],
      [
        '--question',
        'Which?',
        ...Array.from(
          { length: 9 },
          (
            _,
            i,
          ) => [
            '--choice',
            `c${i}`,
          ],
        ).flat(),
      ],
    ]) {
      await refused({
        run: () => ask({ args }),
        code: 'VALIDATION_ERROR',
      })
    }

    const open = await ask({
      args: [
        '--question',
        'What should the README say?',
        '--details-file',
        details,
      ],
    })
    const id = String(open.ask)
    assert.equal(
      f.task().asks?.[0]?.details,
      'Measured on main.',
    )

    for (const args of [
      [],
      [
        '--text',
        '  ',
      ],
      [
        '--choice',
        '1',
      ],
    ]) {
      await refused({
        run: () => f.run({
          args: [
            'answer',
            'ship',
            id,
            ...args,
            '--actor',
            'hydra',
            '--reason',
            'in scope',
          ],
        }),
        code: 'VALIDATION_ERROR',
      })
    }

    const scope = String((await f.run({
      args: [
        'ask',
        'ship',
        '--question',
        'Start with web?',
        '--actor',
        'hydra',
      ],
    })).ask)
    assert.equal(
      f.task().column,
      f.role({ name: 'needs_you' }),
    )
    await f.run({
      args: [
        'answer',
        'ship',
        scope,
        '--text',
        'Yes',
        '--actor',
        'web',
      ],
    })
    assert.equal(
      f.task().column,
      f.role({ name: 'queued' }),
    )

    await refused({
      run: () => f.run({
        args: [
          'answer',
          'ship',
          id,
          '--text',
          'Pnyx guesses',
          '--actor',
          'pnyx',
        ],
      }),
      code: 'NOT_ALLOWED',
    })

    const through = f.state().seq
    await f.run({
      args: [
        'status',
        'ship',
        'working',
        '--note',
        'Starting',
        '--actor',
        'hydra',
      ],
    })
    assert.ok(f.events().some(e => e.type === 'card.moved' && e.seq > through))
    const check = await workerCommands.hydra([
      'check',
      '--after',
      String(through),
      '--hydra',
      'lab',
    ]) as { changes: unknown }
    assert.match(
      String(check.changes),
      /^none:/,
    )
  },
)

test(
  'a worker asks Hydra, which answers once through the worker’s own route; the question resolves on delivery',
  async () => {
    const f = await lab()
    const worker = `worker:${f.task().id}`
    const placed = f.task().column
    const asked = await f.run({
      args: [
        'ask',
        'ship',
        '--question',
        'Which scope?',
        '--context',
        'The diff touches web and core.',
        '--choice',
        'Web only: just web/',
        '--choice',
        'Everything',
        '--recommend',
        '1',
        '--details',
        'grep found 42 files',
        '--actor',
        worker,
      ],
    })
    const id = String(asked.ask)
    const ask = f.task().asks![0]!
    assert.deepEqual(
      [
        ask.actor,
        ask.audience,
        ask.options?.map(o => o.label),
        ask.recommended,
        ask.answered,
      ],
      [
        worker,
        'hydra',
        [
          'Web only',
          'Everything',
        ],
        1,
        undefined,
      ],
    )
    assert.equal(
      lifecycleStage({ card: f.task() }),
      'in_progress',
    )
    assert.equal(
      f.task().column,
      placed,
    )
    assert.equal(
      cardState({
        card: f.task(),
        now: Date.now(),
      }).kind,
      'asks-hydra',
    )

    const message = f.state().hydraMessages!.find(m => m.ask === id)!
    assert.equal(
      message.actor,
      worker,
    )
    await until({ check: () => f.hydraHeard({ report: hydraDelivery({ message }) }) })
    const report = hydraDelivery({ message })
    assert.match(
      report,
      new RegExp(`^<pnyx-report from="${worker}" task="${f.task().id}" message="${message.id}">\\nQuestion ${id}: Which scope\\?`),
    )
    assert.match(
      report,
      /1\. Web only — just web\/ \(recommended\)/,
    )
    assert.doesNotMatch(
      report,
      /grep found 42 files/,
    )
    assert.equal(
      f.hydraSaid().filter(m => m.includes(`Question ${id}:`)).length,
      1,
    )

    const check = await workerCommands.hydra([
      'check',
      '--after',
      '0',
      '--hydra',
      'lab',
    ]) as {
      questions: {
        id: string
        to: string
        from: string
      }[]
    }
    assert.deepEqual(
      check.questions.map(q => [
        q.id,
        q.to,
        q.from,
      ]),
      [
        [
          id,
          'hydra',
          worker,
        ],
      ],
    )
    const digest = String(await workerCommands.hydra([
      'digest',
      '--hydra',
      'lab',
    ]))
    assert.match(
      digest,
      new RegExp(`waiting: question ${id} to you "Which scope\\?"`),
    )

    await refused({
      run: () => f.run({
        args: [
          'answer',
          'ship',
          id,
          '--choice',
          '1',
          '--actor',
          worker,
        ],
      }),
      code: 'NOT_ALLOWED',
    })

    const before = f.workerCall()!.messages.length
    const answer = [
      'answer',
      'ship',
      id,
      '--choice',
      'Web only',
      '--text',
      'Keep core untouched.',
      '--actor',
      'hydra',
      '--reason',
      'the brief names web only',
      '--event-id',
      'answer-1',
    ]
    const receipt = await f.run({ args: answer })
    assert.equal(
      receipt.state,
      'delivered',
    )
    await until({ check: () => f.workerCall()!.messages.length === before + 1 })
    assert.equal(
      f.workerCall()!.messages.at(-1),
      `Answer from Hydra to your question ${id}: Which scope?\nChoice: Web only\nKeep core untouched.`,
    )
    assert.equal(
      f.task().asks![0]!.answered,
      'answer-1',
    )

    assert.equal(
      (await f.run({ args: answer })).state,
      'delivered',
    )
    await refused({
      run: () => f.run({
        args: [
          'answer',
          'ship',
          id,
          '--text',
          'Actually everything',
          '--actor',
          'hydra',
          '--reason',
          'changed my mind',
        ],
      }),
      code: 'ASK_CLOSED',
    })
    await new Promise(resolve => setTimeout(
      resolve,
      50,
    ))
    assert.equal(
      f.workerCall()!.messages.length,
      before + 1,
    )

    const decision = f.timeline().find(u => u.id === id)!.decision!
    assert.deepEqual(
      [
        decision.question,
        decision.choice,
        decision.answer,
        decision.actor,
        decision.reason,
        decision.ask?.from,
        decision.ask?.details,
      ],
      [
        'Which scope?',
        'Web only',
        'Keep core untouched.',
        'Hydra',
        'the brief names web only',
        'The worker',
        'grep found 42 files',
      ],
    )

    const retry = [
      'ask',
      'ship',
      '--question',
      'Ship a PR?',
      '--actor',
      worker,
      '--event-id',
      'ask-retry',
    ]
    const second = String((await f.run({ args: retry })).ask)
    const again = await f.run({ args: retry })
    assert.deepEqual(
      [
        again.ask,
        again.event,
        f.events().filter(e => e.type === 'task.asked' && e.data.id === second).length,
        f.events().filter(e => e.type === 'hydra.message' && e.data.ask === second).length,
      ],
      [
        second,
        'none: duplicate',
        1,
        1,
      ],
    )
    await until({ check: () => f.hydraSaid().some(m => m.includes(`Question ${second}:`)) })
    assert.equal(
      f.hydraSaid().filter(m => m.includes(`Question ${second}:`)).length,
      1,
    )

    const stuck = ({
      reply,
      state,
    }: {
      reply: string
      state: 'queued' | 'delivery_unknown' | 'failed'
    }) => withWriter({
      hydraId: 'lab',
      fn: ({ writer }) => {
        const d = decideReply({
          state: writer.state,
          ref: f.task().id,
          data: {
            reply,
            state,
            route: 'pnyx',
            answers: second,
          },
          meta: {
            at: new Date().toISOString(),
            actor: 'hydra',
          },
        })
        writer.append({ event: (d as { event: HydraEvent }).event })
      },
    })
    const answerSecond = [
      'answer',
      'ship',
      second,
      '--text',
      'Yes, as a draft',
      '--actor',
      'hydra',
      '--reason',
      'ready',
    ]

    for (const state of [
      'queued',
      'delivery_unknown',
    ] as const) {
      stuck({
        reply: `stuck-${state}`,
        state,
      })
      await refused({
        run: () => f.run({ args: answerSecond }),
        code: 'SESSION_WAITING',
      })
      await refused({
        run: () => f.run({
          args: [
            'escalate',
            'ship',
            second,
            '--actor',
            'hydra',
            '--reason',
            'owner merges',
          ],
        }),
        code: 'SESSION_WAITING',
      })
    }

    stuck({
      reply: 'stuck-queued',
      state: 'failed',
    })
    await refused({
      run: () => f.run({ args: answerSecond }),
      code: 'SESSION_WAITING',
    })
    const resent = await f.run({
      args: [
        ...answerSecond,
        '--undelivered',
      ],
    })
    assert.equal(
      resent.state,
      'delivered',
    )
    assert.equal(
      f.task().asks!.find(a => a.id === second)!.answered,
      resent.reply,
    )
  },
)

test(
  'Hydra asks the owner directly; reports, stale prose and quoted reports never answer it, and it survives a restart',
  async () => {
    const f = await lab()
    const worker = `worker:${f.task().id}`

    await refused({
      run: () => f.run({
        args: [
          'ask',
          'ship',
          '--question',
          'Can I widen scope?',
          '--to',
          'owner',
          '--actor',
          worker,
        ],
      }),
      code: 'OWNER_ONLY',
    })
    process.env.PNYX_ACTOR = worker

    try {
      await refused({
        run: () => f.run({
          args: [
            'ask',
            'ship',
            '--question',
            'Can I widen scope?',
            '--to',
            'owner',
            '--actor',
            'hydra',
          ],
        }),
        code: 'OWNER_ONLY',
      })
    } finally {
      delete process.env.PNYX_ACTOR
    }

    const id = String((await f.run({
      args: [
        'ask',
        'ship',
        '--question',
        'Deslop only web, or core too?',
        '--choice',
        'Web only',
        '--choice',
        'Web and core',
        '--actor',
        'hydra',
      ],
    })).ask)
    assert.equal(
      f.task().asks![0]!.audience,
      'owner',
    )
    assert.equal(
      f.task().column,
      f.role({ name: 'needs_you' }),
    )
    await f.run({
      args: [
        'status',
        'ship',
        'paused',
        '--note',
        'Stop until I answer',
        '--actor',
        'web',
      ],
    })

    await workerCommands.hydra([
      'send',
      '--task',
      f.task().id,
      '--text',
      'The owner said web and core; resuming.',
      '--actor',
      worker,
      '--hydra',
      'lab',
    ])
    await f.run({
      args: [
        'ask',
        'ship',
        '--question',
        'Shall I resume?',
        '--actor',
        worker,
      ],
    })
    const quote = `<pnyx-report from="${worker}" task="${f.task().id}">web and core</pnyx-report>`
    await workerCommands.hydra([
      'send',
      '--text',
      quote,
      '--actor',
      'web',
      '--hydra',
      'lab',
    ])
    assert.equal(
      f.state().hydraMessages?.findLast(m => m.text === quote)?.actor,
      'web',
    )
    assert.equal(
      f.task().asks?.find(a => a.id === id)?.answered,
      undefined,
    )
    assert.equal(
      f.task().status?.state,
      'paused',
    )
    assert.ok(!f.events().some(e => (e.type === 'card.replied' && e.data.answers === id)
      || (e.type === 'hydra.message' && e.data.answers === id)))

    assert.match(
      String(await workerCommands.hydra([
        'digest',
        '--hydra',
        'lab',
      ])),
      new RegExp(`question ${id} to the owner "Deslop only web, or core too\\?"`),
    )

    await refused({
      run: () => f.run({
        args: [
          'answer',
          'ship',
          id,
          '--choice',
          '1',
          '--actor',
          'hydra',
          '--reason',
          'the brief says web',
        ],
      }),
      code: 'OWNER_ONLY',
    })

    await server!.close()
    server = await startServer({
      hydraId: 'lab',
      query: f.sdk.query,
    })
    const { state } = loadHydra({ hydraId: 'lab' })
    assert.deepEqual(
      replay({
        state: emptyHydra(),
        events: f.events(),
      }).cards[f.task().id]?.asks,
      state.cards[f.task().id]?.asks,
    )
    assert.equal(
      state.cards[f.task().id]?.asks?.find(a => a.id === id)?.answered,
      undefined,
    )

    await f.run({
      args: [
        'answer',
        'ship',
        id,
        '--choice',
        '2',
        '--text',
        'Core too, but no API changes.',
        '--actor',
        'web',
        '--event-id',
        'owner-answer',
      ],
    })
    const message = f.state().hydraMessages!.findLast(m => m.answers === id)!
    assert.deepEqual(
      [
        message.actor,
        message.text,
        message.choice,
        message.context,
        message.task,
      ],
      [
        'web',
        'Core too, but no API changes.',
        'Web and core',
        `Answers question ${id}: Deslop only web, or core too?\nChoice: Web and core`,
        f.task().id,
      ],
    )
    assert.equal(
      f.task().asks!.find(a => a.id === id)!.answered,
      'owner-answer',
    )
    await until({ check: () => f.hydraSaid().includes(hydraDelivery({ message })) })
    await refused({
      run: () => f.run({
        args: [
          'answer',
          'ship',
          id,
          '--choice',
          '1',
          '--actor',
          'web',
        ],
      }),
      code: 'ASK_CLOSED',
    })
    assert.equal(
      f.task().status?.state,
      'paused',
    )
    assert.equal(
      f.task().column,
      f.role({ name: 'parked' }),
    )
    const decision = f.timeline().find(u => u.id === id)!.decision!
    assert.deepEqual(
      [
        decision.ask?.from,
        decision.choice,
        decision.answer,
        decision.actor,
      ],
      [
        'Hydra',
        'Web and core',
        'Core too, but no API changes.',
        'You',
      ],
    )
  },
)

test(
  'racing answers and an escalation settle once under the writer lock',
  async () => {
    const f = await lab()
    const worker = `worker:${f.task().id}`
    const id = String((await f.run({
      args: [
        'ask',
        'ship',
        '--question',
        'Rename the flag?',
        '--actor',
        worker,
      ],
    })).ask)
    const before = f.workerCall()!.messages.length
    const results = await Promise.allSettled([
      [
        'answer',
        'ship',
        id,
        '--text',
        'Yes',
        '--actor',
        'hydra',
        '--reason',
        'naming is in scope',
      ],
      [
        'escalate',
        'ship',
        id,
        '--actor',
        'hydra',
        '--reason',
        'owner names flags',
      ],
      [
        'answer',
        'ship',
        id,
        '--text',
        'No',
        '--actor',
        'web',
      ],
    ].map(args => Promise.resolve().then(() => f.run({ args }))))
    assert.equal(
      results.filter(r => r.status === 'fulfilled').length,
      1,
    )
    assert.ok(results.every(r => r.status === 'fulfilled'
      || [
        'SESSION_WAITING',
        'ASK_CLOSED',
        'OWNER_ONLY',
      ].includes((r.reason as { code?: string }).code ?? '')))
    await new Promise(resolve => setTimeout(
      resolve,
      100,
    ))
    const ask = f.task().asks!.find(a => a.id === id)!
    assert.equal(
      f.workerCall()!.messages.length - before,
      ask.answered ? 1 : 0,
    )
    assert.equal(
      f.events().filter(e => (e.type === 'card.replied' && e.data.answers === id && e.data.state === 'delivered')
        || e.type === 'task.ask.escalated').length,
      1,
    )
  },
)

test(
  'a real question stays out of Hydra’s chat, while the owner pasting or quoting the same markup keeps their whole message',
  async () => {
    const f = await lab()
    const worker = `worker:${f.task().id}`
    await refused({
      run: () => f.run({
        args: [
          'ask',
          'ship',
          '--question',
          'Mine?',
          '--actor',
          'web',
        ],
      }),
      code: 'NOT_ALLOWED',
    })
    const id = String((await f.run({
      args: [
        'ask',
        'ship',
        '--question',
        'Which scope?',
        '--choice',
        'Web',
        '--choice',
        'All',
        '--actor',
        worker,
      ],
    })).ask)
    const delivered = hydraDelivery({ message: f.state().hydraMessages!.find(m => m.ask === id)! })
    await until({ check: () => f.hydraHeard({ report: delivered }) })

    const quoted = `Did you mean this?\n\n${delivered.split('\n').map(line => `> ${line}`)
      .join('\n')}`

    for (const text of [
      delivered,
      quoted,
    ]) {
      await workerCommands.hydra([
        'send',
        '--text',
        text,
        '--actor',
        'web',
        '--hydra',
        'lab',
      ])
    }

    await until({
      check: () => f.hydraSaid().filter(m => m === delivered).length === 1
        && f.hydraSaid().includes(quoted),
    })

    // An older server delivered a worker's report raw, before reports carried their origin.
    const raw = 'Old raw report: tests pass'
    withWriter({
      hydraId: 'lab',
      fn: ({ writer }) => {
        const d = hydraEvent({
          state: writer.state,
          meta: {
            at: new Date().toISOString(),
            actor: worker,
          },
          cardId: f.task().id,
          change: {
            type: 'hydra.message',
            data: {
              task: f.task().id,
              action: 'send',
              text: raw,
              hydra: 'lab',
            },
          },
        })
        writer.append({ event: (d as { event: HydraEvent }).event })
      },
    })
    appendFileSync(
      f.state().cards[HYDRA_CARD]!.agent!.transcriptPath!,
      `${JSON.stringify({
        type: 'user',
        timestamp: new Date().toISOString(),
        message: {
          role: 'user',
          content: raw,
        },
      })}\n`,
    )

    const transcript = () => {
      const state = loadHydra({ hydraId: 'lab' }).state

      return joinMessageParts({
        entries: readThread({
          hydraId: 'lab',
          state,
          card: state.cards[HYDRA_CARD]!,
          homes: [],
        }).entries,
      })
    }

    const copies = transcript().filter(entry => entry.kind === 'message' && entry.role === 'user')
      .map(entry => entry.kind === 'message' ? entry.text.trim() : '')
    // The worker's own copy rode in a wake, which the transcript never shows; the owner's paste stays.
    assert.equal(
      copies.filter(text => text === delivered).length,
      1,
    )
    assert.ok(copies.includes(quoted) && copies.includes(raw))

    const chat = () => {
      const state = loadHydra({ hydraId: 'lab' }).state

      return hydraMessages({
        messages: state.hydraMessages ?? [],
        transcript: transcript(),
        provider: state.cards[HYDRA_CARD]!.agent!.provider,
      }).filter(entry => entry.kind === 'message' && !entry.role.startsWith('assistant'))
        .map(entry => entry.kind === 'message' ? entry.text : '')
    }

    const owner = [
      delivered,
      quoted,
    ]
    assert.deepEqual(
      chat(),
      owner,
    )

    await server!.close()
    server = await startServer({
      hydraId: 'lab',
      query: f.sdk.query,
    })
    assert.deepEqual(
      chat(),
      owner,
    )
    assert.deepEqual(
      replay({
        state: emptyHydra(),
        events: f.events(),
      }).hydraMessages,
      f.state().hydraMessages,
    )
  },
)

test(
  'Hydra records a newer owner message as an answer without delivering or showing it twice',
  async () => {
    const f = await lab({ worker: false })
    const send = async ({
      id,
      actor,
    }: {
      id: string
      actor: string
    }) => workerCommands.hydra([
      'send',
      '--text',
      'Go ahead with the small change.',
      '--actor',
      actor,
      '--event-id',
      id,
      '--hydra',
      'lab',
    ])
    await send({
      id: 'old-message',
      actor: 'web',
    })
    const question = await f.run({
      args: [
        'ask',
        'ship',
        '--question',
        'May I change this?',
        '--actor',
        'hydra',
      ],
    })
    const id = String(question.ask)
    await send({
      id: 'report-message',
      actor: `worker:${f.task().id}`,
    })
    await send({
      id: 'owner-message',
      actor: 'web',
    })
    const answer = ({ source }: { source: string }) => f.run({
      args: [
        'answer',
        'ship',
        id,
        '--from-message',
        source,
        '--actor',
        'hydra',
        '--reason',
        'The owner answered in conversation',
        '--event-id',
        'record-answer',
      ],
    })

    for (const source of [
      'missing',
      'old-message',
      'report-message',
    ]) {
      await refused({
        run: () => answer({ source }),
        code: 'VALIDATION_ERROR',
      })
    }

    for (const flags of [
      [
        '--actor',
        'web',
      ],
      [
        '--actor',
        'hydra',
        '--text',
        'A replacement quote',
        '--reason',
        'Not the owner’s words',
      ],
      [
        '--actor',
        'hydra',
        '--choice',
        '1',
        '--reason',
        'Not the owner’s words',
      ],
    ]) {
      await refused({
        run: () => f.run({
          args: [
            'answer',
            'ship',
            id,
            '--from-message',
            'owner-message',
            ...flags,
          ],
        }),
        code: 'VALIDATION_ERROR',
      })
    }

    const count = f.hydraSaid().length
    await answer({ source: 'owner-message' })
    const ask = f.task().asks?.find(ask => ask.id === id)
    assert.equal(
      ask?.answered,
      'record-answer',
    )
    assert.equal(
      f.timeline().find(update => update.decision?.questionId === id)?.decision?.actor,
      'You',
    )
    assert.deepEqual(
      ask?.fromMessage,
      {
        id: 'owner-message',
        text: 'Go ahead with the small change.',
        at: f.state().hydraMessages?.find(message => message.id === 'owner-message')?.at,
      },
    )
    assert.equal(
      f.hydraSaid().length,
      count,
    )
    assert.deepEqual(
      replay({
        state: emptyHydra(),
        events: f.events(),
      }).cards[f.task().id]?.asks,
      f.task().asks,
    )
    await answer({ source: 'owner-message' })
    assert.equal(
      f.events().filter(event => event.id === 'record-answer').length,
      1,
    )
  },
)

test(
  'successful start, pause, delivered resume and detach carry their task placement',
  async () => {
    const f = await lab()
    const role = ({ name }: { name: string }) => f.role({ name })
    assert.equal(
      f.task().status?.state,
      'working',
    )
    assert.equal(
      f.task().column,
      role({ name: 'in_progress' }),
    )
    const assignment = f.events().find(e => e.type === 'task.session' && e.data.working)
    const initial = f.task().status
    assert.ok(assignment)
    assert.equal(
      initial?.at,
      assignment.at,
    )
    assert.equal(
      f.events().filter(e => e.type === 'task.declared').length,
      1,
    )
    await f.run({
      args: [
        'status',
        'ship',
        'paused',
        '--note',
        'Wait for CI',
        '--until',
        'in 2 hours',
      ],
    })
    assert.equal(
      f.task().column,
      role({ name: 'parked' }),
    )
    const paused = f.task().status?.id
    const reply = ({ control = false }: { control?: boolean } = {}) => sendReply({
      hydraId: 'lab',
      request: {
        card: f.task().id,
        text: 'Continue with the next step',
        actor: 'cli',
        homes: [],
        control,
      },
    })

    for (const flags of [
      { control: true },
      {
        setting: {
          name: 'model',
          value: 'sonnet',
        },
      },
      { taskMessage: true },
    ] satisfies Partial<ReplyRequest>[]) {
      const result = await sendReply({
        hydraId: 'lab',
        request: {
          card: f.task().id,
          text: 'Context update',
          actor: 'cli',
          homes: [],
          ...flags,
        },
      })
      assert.equal(
        result.state,
        'delivered',
      )
      assert.equal(
        f.task().status?.id,
        paused,
      )
      assert.equal(
        f.task().column,
        role({ name: 'parked' }),
      )
      assert.ok(f.task().status?.until)
    }

    await reply()
    assert.equal(
      f.task().status?.state,
      'working',
    )
    assert.equal(
      f.task().column,
      role({ name: 'in_progress' }),
    )
    assert.equal(
      f.task().status?.until,
      undefined,
    )
    await f.run({
      args: [
        'detach',
        'ship',
      ],
    })
    assert.deepEqual(
      f.task().sessionIds,
      [],
    )
    assert.equal(
      f.task().status?.state,
      'paused',
    )
    assert.equal(
      f.task().column,
      role({ name: 'parked' }),
    )
    assert.deepEqual(
      replay({
        state: emptyHydra(),
        events: f.events(),
      }).cards[f.task().id],
      f.task(),
    )
  },
)

test(
  'answering the matching owner gates clears their waiting declaration only after delivery',
  async () => {
    const f = await lab()
    const questions: string[] = []

    for (const question of [
      'Which scope?',
      'Which target?',
    ]) {
      const asked = await f.run({
        args: [
          'ask',
          'ship',
          '--question',
          question,
          '--actor',
          `worker:${f.task().id}`,
        ],
      })
      const id = String(asked.ask)
      questions.push(id)
      await f.run({
        args: [
          'escalate',
          'ship',
          id,
          '--actor',
          'hydra',
          '--reason',
          'Needs owner choice',
        ],
      })
    }

    await f.run({
      args: [
        'status',
        'ship',
        'needs_you',
        '--note',
        'Owner choices pending',
      ],
    })
    const waiting = f.task().status?.id
    const plain = await sendReply({
      hydraId: 'lab',
      request: {
        card: f.task().id,
        text: 'Some unrelated feedback',
        actor: 'cli',
        homes: [],
      },
    })
    assert.equal(
      plain.state,
      'delivered',
    )
    assert.equal(
      f.task().status?.id,
      waiting,
    )

    for (const [
      i,
      id,
    ] of questions.entries()) {
      await f.run({
        args: [
          'answer',
          'ship',
          id,
          '--text',
          'Use the approved default',
          '--actor',
          'cli',
        ],
      })
      assert.equal(
        f.task().column,
        f.role({ name: i === 0 ? 'needs_you' : 'in_progress' }),
      )
    }

    assert.equal(
      f.task().status?.state,
      'working',
    )
  },
)

test(
  'detach preserves an unresolved owner gate and completed work; ordinary replies do not reopen done',
  async () => {
    const f = await lab()
    const asked = await f.run({
      args: [
        'ask',
        'ship',
        '--question',
        'Choose scope',
        '--actor',
        `worker:${f.task().id}`,
      ],
    })
    await f.run({
      args: [
        'escalate',
        'ship',
        String(asked.ask),
        '--actor',
        'hydra',
        '--reason',
        'Needs choice',
      ],
    })
    const status = f.task().status?.id
    await f.run({
      args: [
        'detach',
        'ship',
      ],
    })
    assert.equal(
      f.task().column,
      f.role({ name: 'needs_you' }),
    )
    assert.equal(
      f.task().status?.id,
      status,
    )
    await server?.close()
    const second = await lab()
    await second.run({
      args: [
        'status',
        'ship',
        'done',
        '--note',
        'Finished the task',
      ],
    })
    await sendReply({
      hydraId: 'lab',
      request: {
        card: second.task().id,
        text: 'Thanks',
        actor: 'cli',
        homes: [],
      },
    })
    assert.equal(
      second.task().status?.state,
      'done',
    )
    await second.run({
      args: [
        'detach',
        'ship',
      ],
    })
    assert.equal(
      second.task().column,
      second.role({ name: 'done' }),
    )
    assert.equal(
      second.task().status?.state,
      'done',
    )
  },
)

test(
  'a terminal hosted failure declares blocked with its reason',
  async () => {
    const f = await lab()
    f.sdk.control.turnError = 'Fixture harness failed'
    await sendReply({
      hydraId: 'lab',
      request: {
        card: f.task().id,
        text: 'Run the next step',
        actor: 'cli',
        homes: [],
      },
    })
    await until({ check: () => f.task().status?.state === 'blocked' })
    assert.match(
      f.task().status?.note ?? '',
      /Fixture harness failed/,
    )
    assert.equal(
      f.task().column,
      f.role({ name: 'needs_you' }),
    )
  },
)

test(
  'a permission answer clears its bound wait and restores the paused phase',
  async () => {
    const f = await lab()
    f.sdk.control.ask = true
    await sendReply({
      hydraId: 'lab',
      request: {
        card: f.task().id,
        text: 'Check the folder',
        actor: 'cli',
        homes: [],
      },
    })
    await until({ check: () => !!f.task().permissions?.some(p => p.status === 'pending') })
    await f.run({
      args: [
        'status',
        'ship',
        'paused',
        '--note',
        'CI pending',
        '--until',
        'in 2 hours',
      ],
    })
    const untilTime = f.task().status?.until
    await f.run({
      args: [
        'status',
        'ship',
        'needs_you',
        '--note',
        'Permission pending',
      ],
    })
    const request = f.task().permissions!.find(p => p.status === 'pending')!
    await f.run({
      args: [
        'permission',
        'ship',
        request.id,
        'allow',
      ],
    })
    assert.equal(
      f.task().status?.state,
      'paused',
    )
    assert.equal(
      f.task().status?.until,
      untilTime,
    )
    assert.equal(
      f.task().column,
      f.role({ name: 'parked' }),
    )
    f.sdk.control.ask = false
  },
)

test(
  'an accepted start preserves the owner custom column',
  async () => {
    const f = await lab({ worker: false })
    await commands.column([
      'create',
      '--id',
      'custom:research',
      '--title',
      'Research',
      '--hydra',
      'lab',
    ])
    await commands.move([
      f.task().id,
      'custom:research',
      '--actor',
      'web',
      '--hydra',
      'lab',
    ])
    await startTask({
      hydraId: 'lab',
      task: f.task().id,
      meta: {
        at: new Date().toISOString(),
        actor: 'cli',
        id: 'custom-start',
      },
    })
    assert.equal(
      f.task().status?.state,
      'working',
    )
    assert.equal(
      f.task().column,
      'custom:research',
    )
  },
)

test(
  'an uncertain reply leaves paused work parked until its delivery is confirmed once',
  async () => {
    const f = await lab()
    await f.run({
      args: [
        'status',
        'ship',
        'paused',
        '--note',
        'Wait for CI',
      ],
    })
    const receipt = ({ state }: { state: 'queued' | 'delivery_unknown' | 'delivered' }) => withWriter({
      hydraId: 'lab',
      fn: ({ writer }) => {
        const decision = decideReply({
          state: writer.state,
          ref: f.task().id,
          data: {
            reply: 'uncertain-resume',
            route: 'pnyx',
            state,
            ...(state === 'queued' ? { resumes: true } : {}),
          },
          meta: {
            at: new Date().toISOString(),
            actor: 'cli',
          },
        })

        if ('event' in decision) {
          writer.append({ event: decision.event })
        }
      },
    })
    receipt({ state: 'queued' })
    receipt({ state: 'delivery_unknown' })
    assert.equal(
      f.task().status?.state,
      'paused',
    )
    assert.equal(
      f.task().column,
      f.role({ name: 'parked' }),
    )
    receipt({ state: 'delivered' })
    assert.equal(
      f.task().status?.state,
      'working',
    )
    await f.run({
      args: [
        'status',
        'ship',
        'paused',
        '--note',
        'Owner hold',
        '--until',
        'in 2 hours',
      ],
    })
    const hold = f.task().status
    receipt({ state: 'delivered' })
    assert.equal(
      f.task().status?.id,
      hold?.id,
    )
    await f.run({
      args: [
        'detach',
        'ship',
      ],
    })
    assert.deepEqual(
      f.task().status,
      hold,
    )
  },
)

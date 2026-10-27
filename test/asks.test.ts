import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { commands } from '../src/cli/commands.ts'
import { startTask } from '../src/cli/start.ts'
import { workerCommands } from '../src/cli/workers.ts'
import type { Card } from '../src/core/model.ts'
import type { RunningServer } from '../src/server/server.ts'
import { loadHydra, readEvents } from '../src/store/hydra-store.ts'
import { taskTimeline } from '../web/src/hydra/task-updates.ts'
import { fakeDispatch } from './dispatch-fixture.ts'
import { hydraSdk } from './hydra-host-fixture.ts'
import { hostObserver } from './host-observer.ts'

const {
  startServer,
  until,
  checkpoint,
} = hostObserver({
  describe: () => loadHydra({ hydraId: 'lab' }).state,
})

// A worker or Hydra session running these tests must not lend them its actor.
delete process.env.PNYX_ACTOR
delete process.env.PNYX_HYDRA

let server: RunningServer | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
})

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
    '--helper',
    'off',
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
      f.role({ name: 'in_progress' }),
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
    assert.equal(
      f.task().column,
      f.role({ name: 'in_progress' }),
    )
    assert.ok(!f.events().some(e => e.type === 'card.moved' && e.seq > through))
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
    await until({ check: () => f.task().sessionActivity === 'finished' })
    await checkpoint()
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

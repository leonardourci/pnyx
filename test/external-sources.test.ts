import assert from 'node:assert/strict'
import { fork, type ChildProcess } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { commands } from '../src/cli/commands.ts'
import { decidePush, decideSession } from '../src/core/decide.ts'
import { bufferedCaptures, commitCapture } from '../src/external-sources/capture.ts'
import { createSourceRunner } from '../src/external-sources/runner.ts'
import { loadHydra, readEvents, withWriter } from '../src/store/hydra-store.ts'
import { until } from './scenarios/harness.ts'
import { lavishFixture } from './scenarios/lavish-fixture.ts'

let root = ''
const runners: ReturnType<typeof createSourceRunner>[] = []

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(
    tmpdir(),
    'pnyx-source-fault-',
  )))
  process.env.PNYX_HOME = join(
    root,
    'pnyx',
  )
  process.env.PNYX_SEMANTIC = 'off'
  copyFileSync(
    join(
      import.meta.dirname,
      'fixtures/external-sources/source.mjs',
    ),
    join(
      root,
      'source.mjs',
    ),
  )
  await commands.hydra([
    'create',
    'lab',
    '--helper',
    'off',
  ])
  await commands.task([
    'create',
    '--key',
    'work',
    '--title',
    'Watch a job',
    '--hydra',
    'lab',
  ])
  withWriter({
    hydraId: 'lab',
    fn: ({ writer }) => {
      const meta = {
        at: new Date().toISOString(),
        actor: 'test',
      }
      const session = decidePush({
        state: writer.state,
        newCardId: 'fixture-session',
        key: 'session',
        input: {
          terminal: { tty: '/dev/ttys123' },
          agent: {
            provider: 'claude-code',
            sessionId: 'fixture',
            cwd: root,
          },
          activity: 'finished',
          source: {
            adapter: 'hooks',
            objectId: 'fixture',
          },
        },
        meta,
      })
      assert.ok('event' in session)
      writer.append({ event: session.event })
      const attached = decideSession({
        state: writer.state,
        ref: 'claude-code:fixture',
        task: writer.state.keys.work!,
        meta,
      })
      assert.ok('event' in attached)
      writer.append({ event: attached.event })
    },
  })
})

afterEach(async () => {
  for (const runner of runners.splice(0)) {
    await runner.close()
  }

  rmSync(
    root,
    {
      recursive: true,
      force: true,
    },
  )
})

const task = () => {
  const state = loadHydra({ hydraId: 'lab' }).state

  return state.cards[state.keys.work!]!
}

async function register({ mode = 'output' }: { mode?: string } = {}) {
  await commands.task([
    'source',
    'register',
    'work',
    'job',
    '--executable',
    process.execPath,
    '--argv',
    JSON.stringify([
      join(
        root,
        'source.mjs',
      ),
      mode,
      root,
      'retained output',
    ]),
    '--cwd',
    root,
    '--hydra',
    'lab',
  ])
}

const delivered = async () => ({
  card: task().id,
  reply: 'notice',
  state: 'delivered' as const,
  sent: true,
})

test(
  'Lavish delivery failure preserves one complete round across runner replacement',
  async () => {
    const fixture = lavishFixture({ folder: root })
    await commands.task([
      ...fixture.arm({
        task: 'work',
        id: 'lavish',
      }).slice(1),
      '--hydra',
      'lab',
    ])
    let notices = 0
    const runner = createSourceRunner({
      hydraId: 'lab',
      changed() {},
      tell: async () => {
        notices++
        throw new Error('Injected Lavish delivery failure')
      },
    })
    runners.push(runner)
    runner.reconcile()
    await until({
      what: 'fixture listening',
      check: () => existsSync(join(
        root,
        'listening',
      )),
    })
    const body = 'session:\n  status: feedback\nprompts[1]{tag,text}:\n  message,"Keep every annotation"\n'
    fixture.deliver({ body })
    await until({
      what: 'round captured',
      check: () => task().externalSources![0]!.results.length > 0,
    })
    runner.reconcile()
    await until({
      what: 'failed delivery recorded',
      check: () => task().steering?.[0]?.attempts.length === 1,
    })
    await runner.close()
    const replacement = createSourceRunner({
      hydraId: 'lab',
      changed() {},
      tell: delivered,
    })
    runners.push(replacement)
    replacement.reconcile()
    await replacement.close()
    assert.equal(
      notices,
      1,
    )
    assert.equal(
      task().externalSources![0]!.results[0]!.stdout,
      body,
    )
    assert.equal(
      task().externalSources![0]!.results[0]!.handled,
      undefined,
    )
    assert.equal(
      task().steering!.length,
      1,
    )
    assert.equal(
      fixture.calls().length,
      1,
    )
  },
)

test(
  'a buffered reply receipt survives runner replacement without posting the staged reply twice',
  async () => {
    const fixture = lavishFixture({ folder: root })
    await commands.task([
      ...fixture.arm({
        task: 'work',
        id: 'lavish',
      }).slice(1),
      '--agent-reply-file',
      fixture.reply,
      '--hydra',
      'lab',
    ])
    let failures = 0
    const runner = createSourceRunner({
      hydraId: 'lab',
      changed() {},
      tell: delivered,
      commit: () => {
        failures++
        throw new Error('Injected unavailable receipt writer')
      },
    })
    runners.push(runner)
    runner.reconcile()
    await until({
      what: 'accepted receipt buffered',
      check: () => failures > 0 && bufferedCaptures({ hydraId: 'lab' }).length === 1,
    })
    assert.equal(
      task().externalSources![0]!.lavish!.reply!.accepted,
      undefined,
    )
    await runner.close()
    const replacement = createSourceRunner({
      hydraId: 'lab',
      changed() {},
      tell: delivered,
    })
    runners.push(replacement)
    replacement.reconcile()
    await until({
      what: 'buffer replay started a poll',
      check: () => existsSync(join(
        root,
        'listening',
      )),
    })
    const source = task().externalSources![0]!
    assert.ok(source.lavish!.reply!.accepted)
    assert.equal(
      source.results.length,
      0,
    )
    assert.equal(
      fixture.calls().filter(call => call.action === 'reply').length,
      1,
    )
    assert.equal(
      fixture.calls().filter(call => call.action === 'poll').length,
      1,
    )
  },
)

test(
  'a capture buffered during writer failure survives runner replacement with its original output',
  async () => {
    await register()
    let rejectWrites = true
    let failures = 0
    const first = createSourceRunner({
      hydraId: 'lab',
      changed() {},
      tell: delivered,
      commit: ({
        hydraId,
        path,
        capture,
      }) => {
        if (rejectWrites) {
          failures++
          throw new Error('Injected unavailable writer')
        }

        commitCapture({
          hydraId,
          path,
          capture,
        })
      },
    })
    runners.push(first)
    first.reconcile()
    await until({
      what: 'both failed persistence boundaries',
      check: () => failures >= 2,
    })
    assert.equal(
      task().externalSources![0]!.state,
      'running',
    )
    assert.equal(
      bufferedCaptures({ hydraId: 'lab' }).length,
      1,
    )
    await first.close()
    rejectWrites = false
    const replacement = createSourceRunner({
      hydraId: 'lab',
      changed() {},
      tell: delivered,
    })
    runners.push(replacement)
    replacement.reconcile()
    await until({
      what: 'the original capture committed after restart',
      check: () =>
        task().externalSources![0]!.results[0],
    })
    assert.equal(
      task().externalSources![0]!.results[0]!.stdout,
      'retained output',
    )
    assert.equal(
      task().externalSources![0]!.results[0]!.outcome,
      'completed',
    )
    assert.equal(
      task().externalSources![0]!.runs,
      1,
    )
    assert.equal(
      task().steering!.length,
      1,
    )
    assert.equal(
      bufferedCaptures({ hydraId: 'lab' }).length,
      0,
    )
    assert.equal(
      readEvents({ hydraId: 'lab' }).filter(event => event.type === 'task.source.result').length,
      1,
    )
  },
)

test(
  'a synchronous supervisor launch failure becomes one retained actionable result',
  async () => {
    await register()
    const runner = createSourceRunner({
      hydraId: 'lab',
      changed() {},
      tell: delivered,
      spawnSource: () => {
        throw new Error('Injected fork failure')
      },
    })
    runners.push(runner)
    runner.reconcile()
    await until({
      what: 'launch failure captured',
      check: () => task().externalSources![0]!.results[0]?.alerted,
    })
    assert.equal(
      task().externalSources![0]!.state,
      'ended',
    )
    assert.equal(
      task().externalSources![0]!.results[0]!.outcome,
      'failed',
    )
    assert.match(
      task().externalSources![0]!.results[0]!.detail,
      /Injected fork failure/,
    )
    runner.reconcile()
    assert.equal(
      task().externalSources![0]!.runs,
      1,
    )
    assert.equal(
      task().externalSources![0]!.results.length,
      1,
    )
  },
)

for (const outcome of [
  'failed',
  'unknown',
] as const) {
  test(
    `a ${outcome} worker notification retains its result and persists one bounded actionable outcome`,
    async () => {
      await register()
      let sends = 0
      const runner = createSourceRunner({
        hydraId: 'lab',
        changed() {},
        tell: async () => {
          sends++

          if (outcome === 'failed') {
            throw new Error('Injected transport failure')
          }

          return {
            card: task().id,
            reply: 'notice',
            state: 'delivery_unknown',
            sent: false,
          }
        },
      })
      runners.push(runner)
      runner.reconcile()
      await until({
        what: 'child output captured',
        check: () => task().externalSources![0]!.results[0],
      })
      runner.reconcile()
      await until({
        what: 'notification uncertainty surfaced',
        check: () =>
          task().externalSources![0]!.results[0]!.alerted,
      })
      runner.reconcile()
      assert.equal(
        sends,
        1,
      )
      assert.equal(
        task().externalSources![0]!.results[0]!.handled,
        undefined,
      )
      assert.equal(
        task().steering![0]!.attempts.length,
        1,
      )
      assert.equal(
        readEvents({ hydraId: 'lab' }).filter(event => event.type === 'task.source.alerted').length,
        1,
      )
    },
  )
}

function processExited({ pid }: { pid: number }): boolean {
  try {
    process.kill(
      pid,
      0,
    )

    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

test(
  'losing the supervisor IPC connection stops the child process group and preserves uncertainty',
  async () => {
    await register({ mode: 'wait-tree' })
    let supervisor: ChildProcess | undefined
    const runner = createSourceRunner({
      hydraId: 'lab',
      changed() {},
      tell: delivered,
      spawnSource: ({ entry }) => {
        supervisor = fork(
          entry,
          [],
          {
            stdio: [
              'ignore',
              'ignore',
              'ignore',
              'ipc',
            ],
          },
        )

        return supervisor
      },
    })
    runners.push(runner)
    runner.reconcile()
    await until({
      what: 'the fixture descendant listening',
      check: () =>
        existsSync(join(
          root,
          'descendant/ready',
        )),
    })
    const childPid = Number(readFileSync(
      join(
        root,
        'ready',
      ),
      'utf8',
    ))
    const descendantPid = Number(readFileSync(
      join(
        root,
        'descendant-pid',
      ),
      'utf8',
    ))
    supervisor!.disconnect()
    await until({
      what: 'the interrupted source retained',
      check: () =>
        task().externalSources![0]!.results[0],
    })
    runner.reconcile()
    await until({
      what: 'owned child group to exit',
      check: () =>
        processExited({ pid: childPid }) && processExited({ pid: descendantPid }),
    })
    assert.equal(
      task().externalSources![0]!.results[0]!.outcome,
      'interrupted',
    )
    assert.equal(
      task().externalSources![0]!.results[0]!.terminal,
      true,
    )
    assert.equal(
      task().externalSources![0]!.results[0]!.handled,
      undefined,
    )
  },
)

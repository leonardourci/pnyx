import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { copyFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { commands } from '../src/cli/commands.ts'
import { decidePush, decideSession } from '../src/core/decide.ts'
import { createSourceRunner } from '../src/external-sources/runner.ts'
import { loadHydra, withWriter } from '../src/store/hydra-store.ts'
import { until } from './scenarios/harness.ts'

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
  'a result the supervisor sends just before exiting is captured even when it is read after the exit',
  async () => {
    await register()
    const runner = createSourceRunner({
      hydraId: 'lab',
      changed() {},
      tell: delivered,
      // A busy server can reap the supervisor before reading its channel: the last message and the
      // channel's end arrive after the exit.
      spawnSource: ({ entry }) => {
        const supervisor = fork(
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
        const emit = supervisor.emit.bind(supervisor)
        const channel: [string, unknown[]][] = []
        let exited = false

        // EventEmitter owns emit's positional signature.
        // eslint-disable-next-line pnyx/object-params
        supervisor.emit = (
          event: string,
          ...args: unknown[]
        ) => {
          if ((event === 'message' || event === 'disconnect') && !exited) {
            channel.push([
              event,
              args,
            ])

            return true
          }

          if (event !== 'exit') {
            return emit(
              event,
              ...args,
            )
          }

          exited = true
          const result = emit(
            event,
            ...args,
          )

          for (const [
            held,
            heldArgs,
          ] of channel.splice(0)) {
            emit(
              held,
              ...heldArgs,
            )
          }

          return result
        }

        return supervisor
      },
    })
    runners.push(runner)
    runner.reconcile()
    await until({
      what: 'the supervisor result captured',
      check: () => task().externalSources![0]!.results[0],
    })
    assert.equal(
      task().externalSources![0]!.results[0]!.outcome,
      'completed',
    )
    assert.equal(
      task().externalSources![0]!.results[0]!.stdout,
      'retained output',
    )
  },
)

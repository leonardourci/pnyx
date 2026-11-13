import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { commands } from '#app/cli.ts'
import { createHost } from '#app/host.ts'
import { loadHydra } from '#app/store.ts'
import { withWriter } from '#app/writer.ts'
import { planTaskChange } from '#tasks/plans.ts'
import { decidePush } from '#tasks/push.ts'
import { fakeDispatch } from '#test-harness/dispatch-fixture.ts'
import { until } from '#test-harness/harness.ts'
import { claudeNative } from '#workers/fixtures/claude-native.ts'
import { trackChildren } from './children.ts'
import { recordTools } from './tools.ts'
import { enqueueSteering } from './inbox.ts'
import { pendingSteering } from './steering.ts'
import { followUpSteering, STEERING_GRACE_MS } from './inbox-follow-up.ts'
import { offerHost } from '#app/server-state.ts'
import { hostRequest } from '#app/host-request.ts'

const CHILD_EXIT_TIMEOUT_MS = 5000

test(
  'tool recovery and reconciliation wait for the earlier agent to be fenced',
  async t => {
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-tool-fence-',
    ))
    const previousHome = process.env.PNYX_HOME
    const previousPath = process.env.PATH
    process.env.PNYX_HOME = join(
      root,
      'pnyx',
    )
    const cwd = join(
      root,
      'worker',
    )
    mkdirSync(cwd)
    fakeDispatch({ root })
    await commands.hydra([
      'create',
      'fence',
    ])
    const task = withWriter({
      hydraId: 'fence',
      fn: ({ writer }) => {
        const created = planTaskChange({
          hydraId: 'fence',
          state: writer.state,
          landing: new Map(),
          operation: {
            op: 'task.create',
            key: 'work',
            title: 'Work',
          },
          meta: {
            actor: 'cli',
            at: new Date().toISOString(),
          },
        })
        assert.ok('event' in created)
        writer.append({ event: created.event })
        const attached = decidePush({
          state: writer.state,
          key: 'work',
          input: {
            activity: 'finished',
            agent: {
              provider: 'claude-code',
              sessionId: 'fenced-conversation',
              resume: true,
              host: 'pnyx',
              cwd,
            },
          },
          meta: {
            actor: 'cli',
            at: new Date().toISOString(),
          },
        })
        assert.ok('event' in attached)
        writer.append({ event: attached.event })

        return created.event.cardId
      },
    })
    recordTools({
      hydraId: 'fence',
      task,
      grant: ['browser'],
      meta: {
        actor: 'cli',
        at: new Date().toISOString(),
      },
    })
    withWriter({
      hydraId: 'fence',
      fn: ({ writer }) => enqueueSteering({
        writer,
        ref: task,
        id: 'fenced-instruction',
        text: 'Continue the work',
        source: 'cli',
        meta: {
          actor: 'cli',
          at: new Date().toISOString(),
        },
      }),
    })
    const child = spawn(
      process.execPath,
      [
        '-e',
        'setInterval(() => {}, 1000)',
      ],
      {
        stdio: 'ignore',
        detached: true,
      },
    )

    const stopChild = async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return
      }

      const exited = once(
        child,
        'exit',
        { signal: AbortSignal.timeout(CHILD_EXIT_TIMEOUT_MS) },
      )
      child.kill('SIGKILL')
      await exited
    }

    const tracker = trackChildren({ hydraId: 'fence' })
    tracker.spawned({ child })
    tracker.associate({
      pid: child.pid!,
      task,
    })
    const kill = process.kill
    const blocked = t.mock.method(
      process,
      'kill',
      // eslint-disable-next-line pnyx/object-params -- process.kill owns this signature.
      (
        pid: number,
        signal?: string | number,
      ) => {
        if (pid === child.pid && signal === 'SIGKILL') {
          return true
        }

        return kill(
          pid,
          signal,
        )
      },
    )
    const sessions: ReturnType<typeof claudeNative>[] = []
    const host = createHost({
      hydraId: 'fence',
      changed: () => {},
      query: ({ ...request }) => {
        const native = claudeNative()
        sessions.push(native)

        return native.query(request)
      },
    })

    const unoffer = offerHost({
      hydraId: 'fence',
      ask: ({ body }) => hostRequest({
        host,
        body,
      }),
    })

    try {
      await host.recover()
      assert.deepEqual(
        host.send({
          card: task,
          text: 'New owner instruction',
          inputId: 'owner-during-fence',
          actor: 'cli',
        }),
        { deferred: true },
      )
      assert.deepEqual(
        host.diagnostics().sessions,
        [],
      )
      await followUpSteering({
        hydraId: 'fence',
        now: Date.now() + STEERING_GRACE_MS,
      })
      assert.equal(
        loadHydra({ hydraId: 'fence' }).state.cards[task]?.steering?.[0]?.attempts.at(-1)?.result,
        'deferred',
      )
      host.toolsChanged({ task })
      host.reconcile({ state: loadHydra({ hydraId: 'fence' }).state })
      assert.deepEqual(
        host.diagnostics().sessions,
        [],
      )
      assert.equal(
        sessions.length,
        0,
      )
      assert.notEqual(
        loadHydra({ hydraId: 'fence' }).state.cards[task]?.toolsApplied,
        loadHydra({ hydraId: 'fence' }).state.cards[task]?.toolsRevision,
      )
      assert.deepEqual(
        pendingSteering({ card: loadHydra({ hydraId: 'fence' }).state.cards[task]! }).map(message => message.id),
        [
          'fenced-instruction',
          'owner-during-fence',
        ],
      )
      blocked.mock.restore()
      await stopChild()
      await host.recover()
      await until({
        what: 'the same pending grant resumes after fencing',
        check: () => sessions[0]?.incoming.length === 1,
      })
      assert.equal(
        sessions[0]!.options()?.resume,
        'fenced-conversation',
      )
      assert.ok(JSON.stringify(sessions[0]!.incoming).includes('fenced-instruction'))
      assert.ok(JSON.stringify(sessions[0]!.incoming).includes('owner-during-fence'))
      await until({
        what: 'fenced grant receipt',
        check: () => {
          const card = loadHydra({ hydraId: 'fence' }).state.cards[task]!

          return card.toolsApplied === card.toolsRevision
        },
      })
    } finally {
      unoffer()
      blocked.mock.restore()

      try {
        await stopChild()
      } finally {
        host.close()

        if (previousHome === undefined) {
          delete process.env.PNYX_HOME
        } else {
          process.env.PNYX_HOME = previousHome
        }

        process.env.PATH = previousPath
        rmSync(
          root,
          {
            recursive: true,
            force: true,
          },
        )
      }
    }
  },
)

test(
  'recovery applies the remaining pending grants when one task folder is gone',
  async () => {
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-tool-recovery-',
    ))
    const previousHome = process.env.PNYX_HOME
    const previousPath = process.env.PATH
    process.env.PNYX_HOME = join(
      root,
      'pnyx',
    )
    fakeDispatch({ root })
    await commands.hydra([
      'create',
      'gone',
    ])
    const tasks = [
      'removed',
      'present',
    ].map(key => {
      const cwd = join(
        root,
        key,
      )
      mkdirSync(cwd)
      const task = withWriter({
        hydraId: 'gone',
        fn: ({ writer }) => {
          const meta = {
            actor: 'cli',
            at: new Date().toISOString(),
          }
          const created = planTaskChange({
            hydraId: 'gone',
            state: writer.state,
            landing: new Map(),
            operation: {
              op: 'task.create',
              key,
              title: key,
            },
            meta,
          })
          assert.ok('event' in created)
          writer.append({ event: created.event })
          const attached = decidePush({
            state: writer.state,
            key,
            input: {
              activity: 'finished',
              agent: {
                provider: 'claude-code',
                sessionId: key,
                resume: true,
                host: 'pnyx',
                cwd,
              },
            },
            meta,
          })
          assert.ok('event' in attached)
          writer.append({ event: attached.event })

          return created.event.cardId
        },
      })
      recordTools({
        hydraId: 'gone',
        task,
        grant: ['browser'],
        meta: {
          actor: 'cli',
          at: new Date().toISOString(),
        },
      })

      return {
        task,
        cwd,
      }
    })
    rmSync(
      tasks[0]!.cwd,
      { recursive: true },
    )
    const sessions = new Map<string, ReturnType<typeof claudeNative>>()
    const host = createHost({
      hydraId: 'gone',
      changed: () => {},
      query: ({ ...request }) => {
        const native = claudeNative()
        sessions.set(
          String(request.options?.resume),
          native,
        )

        return native.query(request)
      },
    })

    try {
      await host.recover()
      await until({
        what: 'the later pending grant resumes its worker',
        check: () => sessions.get('present')?.incoming.length === 1,
      })
      assert.equal(
        sessions.has('removed'),
        false,
      )
    } finally {
      host.close()

      if (previousHome === undefined) {
        delete process.env.PNYX_HOME
      } else {
        process.env.PNYX_HOME = previousHome
      }

      process.env.PATH = previousPath
      rmSync(
        root,
        {
          recursive: true,
          force: true,
        },
      )
    }
  },
)

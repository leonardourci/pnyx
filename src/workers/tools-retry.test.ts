import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mock, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { claudeRecording } from '#test-harness/fake-agents.ts'
import { settle } from '#test-harness/child-fixture.ts'
import { IDLE_MS } from './host.ts'
import { commands } from '#app/cli.ts'
import { createHost } from '#app/host.ts'
import { holdHydra, loadHydra } from '#app/store.ts'
import { withWriter } from '#app/writer.ts'
import { planTaskChange } from '#tasks/plans.ts'
import { decidePush } from '#tasks/push.ts'
import { fakeDispatch } from '#test-harness/dispatch-fixture.ts'
import { until } from '#test-harness/harness.ts'
import { claudeNative } from '#workers/fixtures/claude-native.ts'
import { recordTools } from './tools.ts'
import { taskLease } from '#routine-helper/leases.ts'
import { COPY_LEASE_PREFIX } from '#projects/copy-lease.ts'
import type { HydraError } from '#store/errors.ts'
import { offerHost } from '#app/server-state.ts'
import { hostRequest } from '#app/host-request.ts'
import { runForClient } from '#app/request-context.ts'

// Longer than any wait here, so a delayed retry is never due during the test.
const HOUR_MS = 3_600_000

test(
  'failed tool reopening retries within the host bound and a new revision resets it',
  async () => {
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-tool-retry-',
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
      'retry',
    ])
    const release = holdHydra({
      hydraId: 'retry',
      changed: () => {},
    })
    const sessions = new Map<string, ReturnType<typeof claudeNative>>()
    let failAsync = true, failedQueries = 0
    const host = createHost({
      hydraId: 'retry',
      changed: () => {},
      retryDelays: [
        0,
        0,
      ],
      query: ({ ...request }) => {
        const id = String(request.options?.resume)

        if (id === 'async-retry' && failAsync) {
          failedQueries++
          throw new Error('Fixture provider failed before accepting input')
        }

        const native = claudeNative()
        sessions.set(
          id,
          native,
        )

        return native.query(request)
      },
    })
    const card = ({ task }: { task: string }) => loadHydra({ hydraId: 'retry' }).state.cards[task]!
    let delayedHost: ReturnType<typeof createHost> | undefined
    let timedHost: ReturnType<typeof createHost> | undefined
    let releaseCopy: (() => void) | undefined

    const attach = ({
      key,
      hydraId = 'retry',
    }: {
      key: string
      hydraId?: string
    }) => {
      const cwd = join(
        root,
        key,
      )
      mkdirSync(cwd)
      const task = withWriter({
        hydraId,
        fn: ({ writer }) => {
          const meta = {
            actor: 'cli',
            at: new Date().toISOString(),
          }
          const created = planTaskChange({
            hydraId,
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
                cwd,
                host: 'pnyx',
                resume: true,
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
        hydraId,
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
    }

    try {
      const retry = attach({ key: 'folder-retry' })
      rmSync(
        retry.cwd,
        { recursive: true },
      )
      assert.equal(
        (host.toolsChanged({ task: retry.task }) as HydraError | undefined)?.code,
        'FOLDER_MISSING',
      )
      mkdirSync(retry.cwd)
      host.reconcile({ state: loadHydra({ hydraId: 'retry' }).state })
      await until({
        what: 'restored folder accepts pending tools',
        check: () => sessions.get('folder-retry')?.incoming.length === 1,
      })
      await until({
        what: 'restored-folder grant receipt',
        check: () => {
          const current = card({ task: retry.task })

          return current.toolsApplied === current.toolsRevision
        },
      })

      const result = claudeRecording.turn.find(message => message.type === 'result')
      assert.ok(result?.type === 'result' && result.subtype === 'success')
      mock.timers.enable({
        apis: [
          'setTimeout',
          'Date',
        ],
        now: Date.now(),
      })

      try {
        const native = sessions.get('folder-retry')!
        native.send({
          message: {
            ...result,
            session_id: 'folder-retry',
            uuid: randomUUID(),
            user_message_uuid: native.incoming[0]!.uuid,
            queued_turn_count: 0,
          },
        })
        await settle({
          what: 'applied tool turn finishes',
          check: () => card({ task: retry.task }).sessionActivity === 'finished',
          tick: 1,
        })
        mock.timers.tick(IDLE_MS)
        assert.equal(
          host.diagnostics().sessions.some(session => session.taskId === retry.task),
          false,
        )
      } finally {
        mock.timers.reset()
      }

      const capped = attach({ key: 'folder-cap' })
      rmSync(
        capped.cwd,
        { recursive: true },
      )
      assert.equal(
        (host.toolsChanged({ task: capped.task }) as HydraError | undefined)?.code,
        'FOLDER_MISSING',
      )
      assert.equal(
        (host.toolsChanged({ task: capped.task }) as HydraError | undefined)?.code,
        'FOLDER_MISSING',
      )
      assert.equal(
        host.toolsChanged({ task: capped.task }),
        undefined,
        'the retry bound stops further reopens',
      )
      mkdirSync(capped.cwd)
      host.reconcile({ state: loadHydra({ hydraId: 'retry' }).state })
      assert.equal(
        host.diagnostics().sessions.some(session => session.taskId === capped.task),
        false,
      )
      recordTools({
        hydraId: 'retry',
        task: capped.task,
        revoke: ['browser'],
        meta: {
          actor: 'cli',
          at: new Date().toISOString(),
        },
      })
      host.reconcile({ state: loadHydra({ hydraId: 'retry' }).state })
      await until({
        what: 'new revision resets the retry bound',
        check: () => sessions.get('folder-cap')?.incoming.length === 1,
      })

      const asynchronous = attach({ key: 'async-retry' })
      host.toolsChanged({ task: asynchronous.task })
      await until({
        what: 'both bounded asynchronous failures retire',
        check: () => failedQueries === 2
          && !host.diagnostics().sessions.some(session => session.taskId === asynchronous.task),
      })
      await until({
        what: 'the failed reopen shows on the card',
        check: () => card({ task: asynchronous.task }).status?.state === 'blocked',
      })
      assert.match(
        card({ task: asynchronous.task }).status!.note,
        /Fixture provider failed before accepting input/,
      )
      host.reconcile({ state: loadHydra({ hydraId: 'retry' }).state })
      assert.equal(
        host.diagnostics().sessions.some(session => session.taskId === asynchronous.task),
        false,
      )
      failAsync = false
      recordTools({
        hydraId: 'retry',
        task: asynchronous.task,
        revoke: ['browser'],
        meta: {
          actor: 'cli',
          at: new Date().toISOString(),
        },
      })
      host.reconcile({ state: loadHydra({ hydraId: 'retry' }).state })
      await until({
        what: 'new revision retries after native failure',
        check: () => sessions.get('async-retry')?.incoming.length === 1,
      })
      assert.equal(
        failedQueries,
        2,
      )
      const copyHeld = attach({ key: 'copy-held' })
      releaseCopy = taskLease({
        hydraId: 'retry',
        task: copyHeld.task,
        actor: `${COPY_LEASE_PREFIX}retry-test`,
      })
      host.toolsChanged({ task: copyHeld.task })
      host.toolsChanged({ task: copyHeld.task })
      host.toolsChanged({ task: copyHeld.task })
      assert.equal(
        host.diagnostics().sessions.some(session => session.taskId === copyHeld.task),
        false,
      )
      releaseCopy()
      releaseCopy = undefined
      host.reconcile({ state: loadHydra({ hydraId: 'retry' }).state })
      await until({
        what: 'copy deferral preserves the retry budget',
        check: () => sessions.get('copy-held')?.incoming.length === 1,
      })
      await commands.hydra([
        'create',
        'delayed',
      ])
      let delayedNativeFails = true, delayedQueries = 0
      delayedHost = createHost({
        hydraId: 'delayed',
        changed: () => {},
        retryDelays: [
          HOUR_MS,
          HOUR_MS,
        ],
        query: ({ ...request }) => {
          if (delayedNativeFails) {
            delayedQueries++
            throw new Error('Fixture delayed native failure')
          }

          const native = claudeNative()
          sessions.set(
            'delayed',
            native,
          )

          return native.query(request)
        },
      })
      const delayed = attach({
        key: 'delayed',
        hydraId: 'delayed',
      })
      rmSync(
        delayed.cwd,
        { recursive: true },
      )
      assert.equal(
        (delayedHost.toolsChanged({ task: delayed.task }) as HydraError | undefined)?.code,
        'FOLDER_MISSING',
      )
      mkdirSync(delayed.cwd)
      delayedHost.reconcile({ state: loadHydra({ hydraId: 'delayed' }).state })
      assert.deepEqual(
        delayedHost.diagnostics().sessions,
        [],
      )
      recordTools({
        hydraId: 'delayed',
        task: delayed.task,
        revoke: ['browser'],
        meta: {
          actor: 'cli',
          at: new Date().toISOString(),
        },
      })
      delayedHost.reconcile({ state: loadHydra({ hydraId: 'delayed' }).state })
      await until({
        what: 'delayed native failure retires',
        check: () => delayedQueries === 1 && delayedHost!.diagnostics().sessions.length === 0,
      })
      delayedHost.reconcile({ state: loadHydra({ hydraId: 'delayed' }).state })
      assert.deepEqual(
        delayedHost.diagnostics().sessions,
        [],
      )
      delayedNativeFails = false
      recordTools({
        hydraId: 'delayed',
        task: delayed.task,
        grant: ['browser'],
        meta: {
          actor: 'cli',
          at: new Date().toISOString(),
        },
      })
      delayedHost.reconcile({ state: loadHydra({ hydraId: 'delayed' }).state })
      await until({
        what: 'new revision clears the retry delay',
        check: () => sessions.get('delayed')?.incoming.length === 1,
      })

      await commands.hydra([
        'create',
        'timed',
      ])
      timedHost = createHost({
        hydraId: 'timed',
        changed: () => {},
        retryDelays: [
          50,
          50,
        ],
        query: ({ ...request }) => {
          const native = claudeNative()
          sessions.set(
            'timed',
            native,
          )

          return native.query(request)
        },
      })
      const timed = attach({
        key: 'timed',
        hydraId: 'timed',
      })
      rmSync(
        timed.cwd,
        { recursive: true },
      )
      assert.equal(
        (timedHost.toolsChanged({ task: timed.task }) as HydraError | undefined)?.code,
        'FOLDER_MISSING',
      )
      mkdirSync(timed.cwd)
      await until({
        what: 'a failed reopen retries at its delay with no other event',
        check: () => sessions.get('timed')?.incoming.length === 1,
      })

      const unoffer = offerHost({
        hydraId: 'retry',
        ask: ({ body }) => hostRequest({
          host,
          body,
        }),
      })

      try {
        const cli = attach({ key: 'cli-deferred' })
        rmSync(
          cli.cwd,
          { recursive: true },
        )
        const revoked = await runForClient({
          identity: { PNYX_ACTOR: 'hydra' },
          cwd: root,
          run: () => commands.task([
            'tools',
            cli.task,
            '--revoke',
            'browser',
            '--actor',
            'hydra',
            '--hydra',
            'retry',
          ]),
        })
        assert.match(
          JSON.stringify(revoked),
          /deferred: the agent's folder [^"]+ is gone/,
          'a saved revoke whose reopen failed reports the deferral, not a failure',
        )
        assert.deepEqual(
          card({ task: cli.task }).tools,
          [],
        )
      } finally {
        unoffer()
      }
    } finally {
      releaseCopy?.()
      delayedHost?.close()
      timedHost?.close()
      host.close()
      release()

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

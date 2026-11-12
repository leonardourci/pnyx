import { realpathSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { hydraEvent } from '#hydra/hydra.ts'
import type { QueryFn } from '#workers/claude.ts'
import { planTaskChange } from '#tasks/plans.ts'
import { declareTask } from '#tasks/declarations.ts'
import { readEvents } from '#app/event-log.ts'
import { withWriter } from '#app/writer.ts'
import { decidePush } from '#tasks/push.ts'
import assert from 'node:assert/strict'
import { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mock } from 'node:test'
import { commands } from '#app/cli.ts'
import { createHost } from '#app/host.ts'
import { loadHydra } from '#app/store.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { IDLE_MS } from '#workers/host.ts'
import { claudeNative } from '#workers/fixtures/claude-native.ts'
import { claudeRecording } from '#test-harness/fake-agents.ts'
import { settle } from '#test-harness/child-fixture.ts'

const QUIET_HOST_MS = IDLE_MS * 10
const hydraId = 'idle-fixture'
const native = claudeNative()
const recordedResult = claudeRecording.turn.find(message => message.type === 'result')
assert.ok(recordedResult?.type === 'result' && recordedResult.subtype === 'success')
commands.hydra([
  'create',
  hydraId,
])

const host = createHost({
  hydraId,
  query: native.query,
  changed: () => {},
  wakeDelay: QUIET_HOST_MS,
  stallDelay: QUIET_HOST_MS,
  busyDelay: QUIET_HOST_MS,
})
mock.timers.enable({ apis: ['setTimeout'] })

try {
  await host.hydra({
    id: 'first',
    text: 'First',
    actor: 'cli',
  })
  await settle({
    what: 'first native input',
    check: () => native.incoming.length === 1,
  })
  await host.hydra({
    id: 'queued',
    text: 'Queued',
    actor: 'cli',
  })
  await settle({
    what: 'second native input',
    check: () => native.incoming.length === 2,
  })
  native.send({
    message: {
      ...recordedResult,
      uuid: randomUUID(),
      user_message_uuid: native.incoming[0]!.uuid,
      queued_turn_count: 1,
    },
  })
  await settle({
    what: 'first foreground completion',
    check: () => native.delivered() === 1 && loadHydra({ hydraId }).state.cards[HYDRA_CARD]?.sessionActivity === 'finished',
  })
  mock.timers.tick(IDLE_MS)
  assert.equal(
    native.closed(),
    false,
    'native queued input must survive the idle deadline',
  )

  native.send({
    message: {
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [
        {
          task_id: 'job',
          task_type: 'shell',
          description: 'Background work',
        },
      ],
      uuid: randomUUID(),
      session_id: 'native',
    },
  })
  native.send({
    message: {
      ...recordedResult,
      uuid: randomUUID(),
      user_message_uuid: native.incoming[1]!.uuid,
      queued_turn_count: 0,
    },
  })
  await settle({
    what: 'background work after the second completion',
    check: () => native.delivered() === 3,
  })
  mock.timers.tick(IDLE_MS)
  assert.equal(
    native.closed(),
    false,
    'native background work must survive the idle deadline',
  )

  native.send({
    message: {
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [],
      uuid: randomUUID(),
      session_id: 'native',
    },
  })
  const unknown = {
    ...recordedResult,
    uuid: randomUUID(),
  }
  delete unknown.queued_turn_count
  native.send({ message: unknown })
  await settle({
    what: 'unknown native queue knowledge',
    check: () => native.delivered() === 5,
  })
  mock.timers.tick(IDLE_MS)
  assert.equal(
    native.closed(),
    false,
    'unknown native work must survive the idle deadline',
  )

  native.send({
    message: {
      ...recordedResult,
      uuid: randomUUID(),
      queued_turn_count: 0,
    },
  })
  await settle({
    what: 'settled native work',
    check: () => native.delivered() === 6,
  })
  mock.timers.tick(IDLE_MS - 1)
  assert.equal(
    native.closed(),
    false,
  )
  mock.timers.tick(1)
  assert.equal(
    native.closed(),
    true,
    'the settled session closes at its idle deadline',
  )

  console.log('Native cleanup waited for queued, background and unknown work')
} finally {
  host.close()
  mock.timers.reset()
}

for (const ending of [
  'done',
  'archive',
  'release',
  'idle-release',
  'starting',
  'opening',
]) {
  const worker = claudeNative()
  let childPid: number | undefined

  const query: QueryFn = ({ ...request }) => {
    assert.ok(request.options)

    if (request.options.persistSession !== false) {
      assert.ok(request.options.spawnClaudeCodeProcess)
      const child = request.options.spawnClaudeCodeProcess({
        command: process.execPath,
        args: [
          '-e',
          'setInterval(() => {}, 1000)',
        ],
        cwd: process.env.HOME,
        env: process.env,
        signal: new AbortController().signal,
      })
      assert.ok(child instanceof ChildProcess)
      childPid = child.pid
    }

    return worker.query(request)
  }

  const taskHost = createHost({
    hydraId,
    query,
    changed: () => {},
    wakeDelay: QUIET_HOST_MS,
  })
  const task = withWriter({
    hydraId,
    fn: ({ writer }) => {
      const created = planTaskChange({
        hydraId,
        landing: new Map(),
        state: writer.state,
        operation: {
          op: 'task.create',
          key: `worker-${ending}`,
          title: 'Worker fixture',
        },
        meta: {
          actor: 'cli',
          at: new Date().toISOString(),
        },
      })
      assert.ok('event' in created)
      writer.append({ event: created.event })

      if (ending !== 'starting') {
        const decision = decidePush({
          state: writer.state,
          key: `worker-${ending}`,
          input: {
            agent: {
              provider: 'claude-code',
              sessionId: `worker-${ending}`,
              host: 'pnyx',
              cwd: process.env.HOME,
            },
          },
          meta: {
            actor: 'cli',
            at: new Date().toISOString(),
          },
        })
        assert.ok('event' in decision)
        writer.append({ event: decision.event })
      }

      return Object.values(writer.state.cards).find(card => card.key === `worker-${ending}`)!
    },
  })

  try {
    if (ending === 'starting') {
      const alias = join(
        process.env.HOME!,
        'start-alias',
      )
      symlinkSync(
        process.env.HOME!,
        alias,
        'dir',
      )
      const start = taskHost.start({
        task: task.id,
        prompt: 'Work',
        folder: `${alias}/./`,
        settings: { provider: 'claude-code' },
        actor: 'cli',
        id: 'pending-start',
      })
      assert.deepEqual(
        await taskHost.release({
          task: task.id,
          permanent: true,
        }),
        { busy: 'starting' },
        'a permanent release refuses cleanup before a pending start settles',
      )
      await start
      assert.equal(
        loadHydra({ hydraId }).state.cards[task.id]?.agent?.cwd,
        realpathSync(process.env.HOME!),
      )
    } else {
      taskHost.send({
        card: task.id,
        text: 'Work',
        actor: 'cli',
        direct: true,
        inputId: `input-${ending}`,
      })

      if (ending === 'opening') {
        assert.deepEqual(
          await taskHost.release({
            task: task.id,
            permanent: true,
          }),
          { busy: 'starting' },
          'a permanent release refuses cleanup before a lazy opening settles',
        )
      }
    }

    await settle({
      what: 'worker input',
      check: () => worker.incoming.length === 1,
    })
    assert.ok(childPid)
    const pid = childPid
    assert.equal(
      process.kill(
        -childPid,
        0,
      ),
      true,
    )

    if (ending === 'idle-release') {
      worker.send({
        message: {
          ...recordedResult,
          uuid: randomUUID(),
          user_message_uuid: worker.incoming[0]!.uuid,
          queued_turn_count: 0,
        },
      })
      await settle({
        what: 'worker completion',
        check: () => worker.delivered() === 1,
      })
      assert.deepEqual(
        await taskHost.release({ task: task.id }),
        { released: 1 },
      )
      assert.equal(
        process.kill(
          -childPid,
          0,
        ),
        true,
        'ordinary release preserves detached work',
      )
      await taskHost.release({
        task: task.id,
        permanent: true,
      })
    } else if (ending === 'release' || ending === 'starting' || ending === 'opening') {
      assert.deepEqual(
        await taskHost.release({ task: task.id }),
        { busy: 'mid-turn' },
      )
      assert.deepEqual(
        await taskHost.release({
          task: task.id,
          permanent: true,
        }),
        { released: 1 },
      )
    } else {
      withWriter({
        hydraId,
        fn: ({ writer }) => {
          const decision = ending === 'archive' ? hydraEvent({
            state: writer.state,
            cardId: task.id,
            change: {
              type: 'task.visibility',
              data: {
                before: false,
                after: true,
                automatic: false,
              },
            },
            meta: {
              actor: 'cli',
              at: new Date().toISOString(),
            },
          }) : declareTask({
            state: writer.state,
            ref: task.id,
            status: 'done',
            note: 'Complete',
            meta: {
              actor: 'cli',
              at: new Date().toISOString(),
            },
          })
          assert.ok('event' in decision)
          writer.append({ event: decision.event })
        },
      })
      const state = loadHydra({ hydraId }).state
      const card = state.cards[task.id]!
      assert.equal(
        ending === 'archive' ? card.hidden : card.status?.state === 'done',
        true,
      )
      taskHost.reconcile({ state })
    }

    await settle({
      what: `${ending} closes worker`,
      check: () => worker.closed(),
    })
    await settle({
      what: `${ending} reaps worker group`,
      check: () => {
        try {
          process.kill(
            -pid,
            0,
          )

          return false
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code

          if (code === 'EPERM') {
            return false
          }

          assert.equal(
            code,
            'ESRCH',
          )

          return true
        }
      },
    })

    if (ending === 'release') {
      const folder = realpathSync(process.env.HOME!)
      const alias = join(
        folder,
        'released-alias',
      )
      symlinkSync(
        folder,
        alias,
        'dir',
      )
      withWriter({
        hydraId,
        fn: ({ writer }) => {
          const card = writer.state.cards[task.id]!
          const attached = decidePush({
            state: writer.state,
            key: card.key,
            input: {
              agent: {
                ...card.agent!,
                cwd: `${alias}/./`,
              },
            },
            meta: {
              actor: 'cli',
              at: new Date().toISOString(),
            },
          })
          assert.ok('event' in attached)
          writer.append({ event: attached.event })
          const removed = hydraEvent({
            state: writer.state,
            cardId: task.id,
            meta: {
              actor: 'cli',
              at: new Date().toISOString(),
            },
            change: {
              type: 'task.copy',
              data: {
                before: card.copy ?? null,
                after: {
                  path: folder,
                  project: folder,
                  via: 'command',
                  state: 'removed',
                  reason: 'released while its folder stays available',
                },
              },
            },
          })
          assert.ok('event' in removed)
          writer.append({ event: removed.event })
        },
      })
      assert.throws(
        () => taskHost.send({
          card: task.id,
          text: 'Reply to a released alias',
          actor: 'cli',
          direct: true,
        }),
        { code: 'FOLDER_MISSING' },
      )
    }
  } finally {
    if (childPid) {
      try {
        process.kill(
          -childPid,
          'SIGKILL',
        )
      } catch (error) {
        assert.equal(
          (error as NodeJS.ErrnoException).code,
          'ESRCH',
          `${ending} child group ${childPid}`,
        )
      }
    }

    taskHost.close()
  }
}

console.log('Task completion, archive and release close their hosted sessions')

const recoveryWorker = claudeNative()
const recoveryHost = createHost({
  hydraId,
  query: recoveryWorker.query,
  changed: () => {},
  wakeDelay: QUIET_HOST_MS,
})

try {
  withWriter({
    hydraId,
    fn: ({ writer }) => {
      const created = planTaskChange({
        hydraId,
        landing: new Map(),
        state: writer.state,
        operation: {
          op: 'task.create',
          key: 'completed-before-restart',
          title: 'Completed worker fixture',
        },
        meta: {
          actor: 'cli',
          at: new Date().toISOString(),
        },
      })
      assert.ok('event' in created)
      writer.append({ event: created.event })
      const started = decidePush({
        state: writer.state,
        key: 'completed-before-restart',
        input: {
          activity: 'working',
          agent: {
            provider: 'claude-code',
            sessionId: 'completed-before-restart',
            host: 'pnyx',
            cwd: process.env.HOME,
          },
        },
        meta: {
          actor: 'cli',
          at: new Date().toISOString(),
        },
      })
      assert.ok('event' in started)
      writer.append({ event: started.event })
      const task = writer.state.keys['completed-before-restart']!
      const completed = declareTask({
        state: writer.state,
        ref: task,
        status: 'done',
        note: 'Complete',
        meta: {
          actor: 'cli',
          at: new Date().toISOString(),
        },
      })
      assert.ok('event' in completed)
      writer.append({ event: completed.event })
    },
  })
  const turn = readEvents({ hydraId }).findLast(event => event.type === 'card.pushed' && event.data.agent?.sessionId === 'completed-before-restart' && event.data.activity === 'working')!
  assert.ok(turn)
  await recoveryHost.recover()
  assert.equal(
    `resume:${turn.seq}` in loadHydra({ hydraId }).state.eventIds,
    false,
    'restart must not resume a completed worker',
  )
} finally {
  recoveryHost.close()
}

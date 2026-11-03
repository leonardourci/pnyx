import assert from 'node:assert/strict'
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

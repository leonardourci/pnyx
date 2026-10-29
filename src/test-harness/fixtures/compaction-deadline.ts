import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mock } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { commands } from '#app/cli.ts'
import { createHost } from '#app/host.ts'
import { loadHydra } from '#app/store.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { IDLE_MS } from '#workers/host.ts'
import { claudeNative } from '#workers/fixtures/claude-native.ts'
import { claudeRecording } from '#test-harness/fake-agents.ts'

const WAIT_MS = 5000
const DEADLINE_MS = 60_000
const QUIET_HOST_MS = IDLE_MS * 10
const hydraId = 'compaction-deadline'
const native = claudeNative()
const recordedResult = claudeRecording.turn.find(message => message.type === 'result')
assert.ok(recordedResult?.type === 'result' && recordedResult.subtype === 'success')
commands.hydra([
  'create',
  hydraId,
])

async function settle({
  what,
  check,
}: {
  what: string
  check(): boolean
}) {
  const until = Date.now() + WAIT_MS

  while (!check()) {
    assert.ok(
      Date.now() < until,
      what,
    )
    await setImmediate()
  }
}

const compaction = () => loadHydra({ hydraId }).state.cards[HYDRA_CARD]?.compaction
const compacting = () => native.send({
  message: {
    type: 'system',
    subtype: 'status',
    status: 'compacting',
    uuid: randomUUID(),
    session_id: 'native',
  },
})

const host = createHost({
  hydraId,
  query: native.query,
  changed: () => {},
  wakeDelay: QUIET_HOST_MS,
  stallDelay: QUIET_HOST_MS,
  busyDelay: QUIET_HOST_MS,
  compactionDelay: DEADLINE_MS,
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
  native.send({
    message: {
      ...recordedResult,
      uuid: randomUUID(),
      user_message_uuid: native.incoming[0]!.uuid,
      queued_turn_count: 0,
    },
  })
  await settle({
    what: 'first turn to finish',
    check: () => loadHydra({ hydraId }).state.cards[HYDRA_CARD]?.sessionActivity === 'finished',
  })

  await host.hydra({
    id: 'compact',
    text: '/compact',
    actor: 'cli',
  })
  await settle({
    what: 'the manual compaction to start',
    check: () => native.incoming.length === 2 && compaction()?.operations[0]?.state === 'running',
  })
  compacting()
  await settle({
    what: 'the compaction status',
    check: () => native.delivered() === 2,
  })
  await host.hydra({
    id: 'held',
    text: 'Held while compacting',
    actor: 'cli',
  })
  assert.equal(
    compaction()?.inputs[0]?.id,
    'held',
  )

  mock.timers.tick(DEADLINE_MS - 1)
  compacting()
  await settle({
    what: 'the repeated compaction status',
    check: () => native.delivered() === 3,
  })
  mock.timers.tick(DEADLINE_MS - 1)
  assert.equal(
    compaction()?.operations.length,
    1,
  )
  assert.equal(
    compaction()?.operations[0]?.state,
    'running',
    'each status from the agent restarts the deadline',
  )

  mock.timers.tick(1)
  await settle({
    what: 'the silent compaction to fail',
    check: () => compaction()?.operations[0]?.state === 'failed',
  })
  assert.equal(
    compaction()?.operations[0]?.error,
    'The agent stopped reporting this compaction before it finished',
  )

  for (let tick = 0; !native.incoming.some(message => JSON.stringify(message).includes('Held while compacting')); tick++) {
    assert.ok(
      tick < 1000,
      'the held message reaches the agent',
    )
    mock.timers.tick(20)
    await setImmediate()
  }

  console.log('A silent compaction failed at its deadline and released held input')
} finally {
  host.close()
  mock.timers.reset()
}

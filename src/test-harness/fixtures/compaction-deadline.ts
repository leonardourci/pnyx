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
import { settle } from '#test-harness/child-fixture.ts'

const DEADLINE_MS = 60_000
// The host releases held input on 20 ms polls of the mocked clock.
const RELEASE_TICK_MS = 20
const QUIET_HOST_MS = IDLE_MS * 10
const hydraId = 'compaction-deadline'
const native = claudeNative()
const recordedResult = claudeRecording.turn.find(message => message.type === 'result')
assert.ok(recordedResult?.type === 'result' && recordedResult.subtype === 'success')
commands.hydra([
  'create',
  hydraId,
])

const compaction = () => loadHydra({ hydraId }).state.cards[HYDRA_CARD]?.compaction
const status = ({ result }: { result?: 'success' }) => native.send({
  message: {
    type: 'system',
    subtype: 'status',
    status: result ? null : 'compacting',
    ...(result ? { compact_result: result } : {}),
    uuid: randomUUID(),
    session_id: 'native',
  },
})
const finish = ({
  input,
  queued,
}: {
  input: number
  queued: number
}) => native.send({
  message: {
    ...recordedResult,
    uuid: randomUUID(),
    user_message_uuid: native.incoming[input]!.uuid,
    queued_turn_count: queued,
  },
})
const received = ({ text }: { text: string }) => native.incoming
  .some(message => JSON.stringify(message).includes(text))

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
  finish({
    input: 0,
    queued: 0,
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
  status({})
  // The native fake counts a message delivered once the host asks for the next, so the host has handled it.
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
  status({})
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

  await settle({
    what: 'the held message to reach the agent',
    check: () => received({ text: 'Held while compacting' }) && !compaction()?.inputs.length,
    tick: RELEASE_TICK_MS,
  })

  status({ result: 'success' })
  await settle({
    what: 'the late compaction result',
    check: () => native.delivered() === 4,
  })
  assert.deepEqual(
    compaction()?.operations.map(operation => operation.state),
    ['failed'],
    'a result after the deadline leaves the failed operation as it is',
  )

  finish({
    input: 1,
    queued: 1,
  })
  finish({
    input: 2,
    queued: 0,
  })
  await settle({
    what: 'the compact and held turns to finish',
    check: () => native.delivered() === 6
      && loadHydra({ hydraId }).state.cards[HYDRA_CARD]?.sessionActivity === 'finished',
  })

  await host.hydra({
    id: 'unanswered',
    text: '/compact',
    actor: 'cli',
  })
  await settle({
    what: 'a /compact the agent never answers to start',
    check: () => native.incoming.length === 4 && compaction()?.operations[1]?.state === 'running',
  })
  await host.hydra({
    id: 'held-again',
    text: 'Held while unanswered',
    actor: 'cli',
  })
  mock.timers.tick(DEADLINE_MS - 1)
  // What that tick started finishes before the deadline, as it would on a real clock.
  await setImmediate()
  assert.equal(
    compaction()?.operations[1]?.state,
    'running',
  )
  mock.timers.tick(1)
  await settle({
    what: 'the unanswered compaction to fail and release its held message',
    check: () => compaction()?.operations[1]?.state === 'failed' && received({ text: 'Held while unanswered' }),
    tick: RELEASE_TICK_MS,
  })

  console.log('Silent and unanswered compactions failed at their deadline and released held input')
} finally {
  host.close()
  mock.timers.reset()
}

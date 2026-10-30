import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mock } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { commands } from '#app/cli.ts'
import { createHost } from '#app/host.ts'
import { loadHydra } from '#app/store.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { IDLE_MS } from '#workers/host.ts'
import { claudeNative } from '#workers/fixtures/claude-native.ts'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
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
const states = () => compaction()?.operations.map(operation => `${operation.trigger}:${operation.state}`)
const received = ({ text }: { text: string }) => native.incoming
  .some(message => JSON.stringify(message).includes(text))
const finished = () => loadHydra({ hydraId }).state.cards[HYDRA_CARD]?.sessionActivity === 'finished'
const writerLock = join(
  process.env.PNYX_HOME!,
  'hydras',
  hydraId,
  'writer.lock',
)

// The native fake counts a message delivered once the host asks for the next, so the host has handled it.
async function send({ message }: { message: SDKMessage }) {
  const before = native.delivered()
  native.send({ message })
  await settle({
    what: `the host to handle a ${message.type} message`,
    check: () => native.delivered() > before,
  })
}

const status = ({ result }: { result?: 'success' }) => send({
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
}) => send({
  message: {
    ...recordedResult,
    uuid: randomUUID(),
    user_message_uuid: native.incoming[input]!.uuid,
    queued_turn_count: queued,
  },
})

async function compact({
  id,
  input,
}: {
  id: string
  input: number
}) {
  const operations = compaction()?.operations.length ?? 0
  await host.hydra({
    id,
    text: '/compact',
    actor: 'cli',
  })
  await settle({
    what: `/compact ${id} to start`,
    check: () => native.incoming.length === input + 1 && compaction()?.operations[operations]?.state === 'running',
  })
}

async function hold({
  id,
  text,
}: {
  id: string
  text: string
}) {
  await host.hydra({
    id,
    text,
    actor: 'cli',
  })
  assert.ok(compaction()?.inputs.some(input => input.id === id))
}

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
  await finish({
    input: 0,
    queued: 0,
  })
  await settle({
    what: 'first turn to finish',
    check: finished,
  })

  await compact({
    id: 'compact',
    input: 1,
  })
  await status({})
  await hold({
    id: 'held',
    text: 'Held while compacting',
  })
  mock.timers.tick(DEADLINE_MS - 1)
  await status({})
  mock.timers.tick(DEADLINE_MS - 1)
  assert.deepEqual(
    states(),
    ['manual:running'],
    'each status from the agent restarts the deadline',
  )

  // Another writer holds the lock as the deadline passes, so recording the failure must wait for it.
  writeFileSync(
    writerLock,
    String(process.pid),
  )
  mock.timers.tick(1)
  assert.deepEqual(
    states(),
    ['manual:running'],
  )
  rmSync(writerLock)
  await settle({
    what: 'the silent compaction to fail once the lock is free',
    check: () => compaction()?.operations[0]?.state === 'failed',
    tick: RELEASE_TICK_MS,
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

  // The same compaction reports again after its deadline: Claude Code gives the status a new uuid, then sends its result.
  await status({})
  await status({ result: 'success' })
  assert.deepEqual(
    states(),
    ['manual:failed'],
    'a status or result after the deadline leaves the failed operation as it is',
  )
  await status({})
  await status({ result: 'success' })
  assert.deepEqual(
    states(),
    [
      'manual:failed',
      'auto:done',
    ],
    'a later compaction is its own operation',
  )

  await finish({
    input: 1,
    queued: 1,
  })
  await finish({
    input: 2,
    queued: 0,
  })
  await settle({
    what: 'the compact and held turns to finish',
    check: finished,
  })

  await compact({
    id: 'unanswered',
    input: 3,
  })
  await hold({
    id: 'held-unanswered',
    text: 'Held while unanswered',
  })
  mock.timers.tick(DEADLINE_MS - 1)
  // What that tick started finishes before the deadline, as it would on a real clock.
  await setImmediate()
  assert.equal(
    compaction()?.operations[2]?.state,
    'running',
  )
  mock.timers.tick(1)
  await settle({
    what: 'the unanswered compaction to fail and release its held message',
    check: () => compaction()?.operations[2]?.state === 'failed' && received({ text: 'Held while unanswered' }),
    tick: RELEASE_TICK_MS,
  })
  await finish({
    input: 3,
    queued: 1,
  })
  await finish({
    input: 4,
    queued: 0,
  })
  await settle({
    what: 'the unanswered and held turns to finish',
    check: finished,
  })

  // Claude Code starts a second compaction a while after the first one's result, within the same turn.
  await compact({
    id: 'chained',
    input: 5,
  })
  await status({})
  await hold({
    id: 'held-chained',
    text: 'Held through both compactions',
  })
  await status({ result: 'success' })

  for (let tick = 0; tick < 10; tick++) {
    mock.timers.tick(RELEASE_TICK_MS)
    await setImmediate()
  }

  await status({})
  await status({ result: 'success' })
  assert.deepEqual(
    states()?.slice(3),
    [
      'manual:done',
      'auto:done',
    ],
  )
  assert.equal(
    received({ text: 'Held through both compactions' }),
    false,
    'held input waits while the agent is still compacting',
  )
  await finish({
    input: 5,
    queued: 0,
  })
  await settle({
    what: 'the held message to reach the agent after the second compaction',
    check: () => received({ text: 'Held through both compactions' }),
    tick: RELEASE_TICK_MS,
  })

  console.log('Compactions kept one operation each, failed at their deadline and released held input after the last')
} finally {
  host.close()
  mock.timers.reset()
}

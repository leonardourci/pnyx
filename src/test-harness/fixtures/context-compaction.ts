import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mock } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { HYDRA_TURN_POLL_MS } from '#workers/host.ts'
import { commands } from '#app/cli.ts'
import { createHost } from '#app/host.ts'
import { loadHydra } from '#app/store.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { claudeNative } from '#workers/fixtures/claude-native.ts'
import { claudeRecording } from '#test-harness/fake-agents.ts'
import { settle } from '#test-harness/child-fixture.ts'

const hydraId = 'context-limit'
const native = claudeNative()
const result = claudeRecording.turn.find(message => message.type === 'result')
const start = claudeRecording.turn.find(message => message.type === 'stream_event' && message.event.type === 'message_start')
assert.ok(result?.type === 'result' && result.subtype === 'success')
assert.ok(start?.type === 'stream_event' && start.event.type === 'message_start')
await commands.owner([
  'memory',
  'set',
  '--key',
  'context-probe',
  '--text',
  'Synthetic policy survives native compaction',
])
commands.hydra([
  'create',
  hydraId,
])
const host = createHost({
  hydraId,
  query: native.query,
  changed: () => {},
  wakeDelay: 60_000,
  stallDelay: 60_000,
})

const complete = ({
  input,
  used,
}: {
  input: number
  used: number
}) => {
  assert.ok(start.event.type === 'message_start')
  native.send({
    message: {
      ...start,
      event: {
        ...start.event,
        message: {
          ...start.event.message,
          usage: {
            ...start.event.message.usage,
            input_tokens: used,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      },
    },
  })
  native.send({
    message: {
      ...result,
      uuid: randomUUID(),
      user_message_uuid: native.incoming[input]!.uuid,
      queued_turn_count: 0,
    },
  })
}

try {
  await host.hydra({
    id: 'below',
    text: 'Below the limit',
    actor: 'cli',
  })
  await settle({
    what: 'first input',
    check: () => native.incoming.length === 1,
  })
  complete({
    input: 0,
    used: 199_999,
  })
  await settle({
    what: 'below-limit turn to settle',
    check: () => native.delivered() === 2 && loadHydra({ hydraId }).state.cards[HYDRA_CARD]?.sessionActivity === 'finished',
  })
  assert.equal(
    native.incoming.length,
    1,
  )
  await host.hydra({
    id: 'at-limit',
    text: 'At the limit',
    actor: 'cli',
  })
  await settle({
    what: 'second input',
    check: () => native.incoming.length === 2,
  })
  complete({
    input: 1,
    used: 200_000,
  })
  await settle({
    what: 'automatic compact input at the context limit',
    check: () => native.incoming.length >= 3,
  })
  assert.equal(
    native.incoming[2]!.message.content,
    '/compact',
  )
  await settle({
    what: 'automatic compaction status',
    check: () => loadHydra({ hydraId }).state.cards[HYDRA_CARD]?.compaction?.operations.at(-1)?.trigger === 'auto',
  })
  native.send({
    message: {
      type: 'system',
      subtype: 'status',
      status: 'compacting',
      uuid: randomUUID(),
      session_id: '',
    },
  })
  native.send({
    message: {
      type: 'system',
      subtype: 'status',
      status: null,
      compact_result: 'success',
      uuid: randomUUID(),
      session_id: '',
    },
  })
  native.send({
    message: {
      ...result,
      uuid: randomUUID(),
      user_message_uuid: native.incoming[2]!.uuid,
      queued_turn_count: 0,
    },
  })
  await settle({
    what: 'compaction to finish without repeating stale high usage',
    check: () => native.delivered() === 7 && loadHydra({ hydraId }).state.cards[HYDRA_CARD]?.sessionActivity === 'finished',
  })
  await setImmediate()
  await setImmediate()
  assert.equal(
    native.incoming.length,
    3,
  )
  const hook = native.options()?.hooks?.SessionStart?.find(item => item.matcher === 'compact')?.hooks[0]
  assert.ok(
    hook,
    'the native provider must restore context after compact',
  )
  const restored = await hook(
    {
      hook_event_name: 'SessionStart',
      source: 'compact',
      cwd: native.options()?.cwd ?? '',
      transcript_path: '',
      session_id: '',
    },
    undefined,
    { signal: new AbortController().signal },
  )
  assert.ok('hookSpecificOutput' in restored)
  assert.ok(restored.hookSpecificOutput?.hookEventName === 'SessionStart')
  assert.match(
    restored.hookSpecificOutput.additionalContext ?? '',
    /Synthetic policy survives native compaction/,
  )
  assert.match(
    restored.hookSpecificOutput.additionalContext ?? '',
    /pnyx-axi hydra history/,
  )
  mock.timers.enable({ apis: ['setTimeout'] })
  await host.hydra({
    id: 'reset-reading',
    text: 'Reset the usage reading',
    actor: 'cli',
  })
  await settle({
    what: 'reset input',
    check: () => native.incoming.length === 4,
  })
  complete({
    input: 3,
    used: 199_999,
  })
  await settle({
    what: 'reset completion',
    check: () => native.delivered() === 9,
  })
  await host.hydra({
    id: 'busy-limit',
    text: 'Reach the limit with a pending wake',
    actor: 'cli',
  })
  await settle({
    what: 'busy input',
    check: () => native.incoming.length === 5,
  })
  await host.hydra({
    id: 'admitted-wake',
    text: 'Admitted wake must run first',
    actor: 'pnyx',
  })
  await setImmediate()
  complete({
    input: 4,
    used: 200_000,
  })
  await settle({
    what: 'busy completion',
    check: () => native.delivered() === 11,
  })
  await setImmediate()
  await setImmediate()
  assert.equal(
    native.incoming.length,
    5,
    'automatic compaction must wait behind an admitted wake',
  )
  mock.timers.tick(HYDRA_TURN_POLL_MS)
  await settle({
    what: 'admitted wake delivery',
    check: () => native.incoming.length === 6,
  })
  assert.match(
    String(native.incoming[5]!.message.content),
    /Admitted wake must run first/,
  )
  complete({
    input: 5,
    used: 199_999,
  })
  await settle({
    what: 'wake completion',
    check: () => native.delivered() === 13,
  })
  await host.hydra({
    id: 'next-high-context',
    text: 'Reach the limit again after a fresh low reading',
    actor: 'cli',
  })
  await settle({
    what: 'next high input',
    check: () => native.incoming.length === 7,
  })
  complete({
    input: 6,
    used: 200_000,
  })
  await settle({
    what: 'compaction to re-arm after a lower usage reading',
    check: () => native.incoming.length === 8,
  })
  assert.equal(
    native.incoming[7]!.message.content,
    '/compact',
  )
  console.log('Context compacts at the limit and does not loop on a stale reading')
} finally {
  host.close()
  mock.timers.reset()
}

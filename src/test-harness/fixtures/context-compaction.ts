import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
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
    what: 'at-limit turn to finish',
    check: () => native.delivered() === 4 && loadHydra({ hydraId }).state.cards[HYDRA_CARD]?.sessionActivity === 'finished',
  })
  await setImmediate()
  await setImmediate()
  assert.equal(
    native.incoming.length,
    2,
    'Pnyx must not request compaction at 200,000 reported tokens',
  )
  assert.equal(
    loadHydra({ hydraId }).state.cards[HYDRA_CARD]?.compaction,
    undefined,
  )
  await host.hydra({
    id: 'above-limit',
    text: 'Continue above the old limit',
    actor: 'cli',
  })
  await settle({
    what: 'third input',
    check: () => native.incoming.length === 3,
  })
  assert.match(
    String(native.incoming[2]!.message.content),
    /Continue above the old limit/,
  )
  complete({
    input: 2,
    used: 250_000,
  })
  await settle({
    what: 'above-limit turn to finish',
    check: () => native.delivered() === 6 && loadHydra({ hydraId }).state.cards[HYDRA_CARD]?.sessionActivity === 'finished',
  })
  await setImmediate()
  await setImmediate()
  assert.equal(
    native.incoming.length,
    3,
    'Pnyx must not request compaction above 200,000 reported tokens',
  )
  assert.equal(
    loadHydra({ hydraId }).state.cards[HYDRA_CARD]?.compaction,
    undefined,
  )
  await host.hydra({
    id: 'owner-compact',
    text: '/compact',
    actor: 'cli',
  })
  await settle({
    what: 'owner compact input',
    check: () => native.incoming.length === 4,
  })
  assert.equal(
    native.incoming[3]!.message.content,
    '/compact',
  )
  assert.equal(
    loadHydra({ hydraId }).state.cards[HYDRA_CARD]?.compaction?.operations.at(-1)?.trigger,
    'manual',
  )
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
      user_message_uuid: native.incoming[3]!.uuid,
      queued_turn_count: 0,
    },
  })
  await settle({
    what: 'owner compaction to finish',
    check: () => native.delivered() === 9 && loadHydra({ hydraId }).state.cards[HYDRA_CARD]?.sessionActivity === 'finished',
  })
  await setImmediate()
  await setImmediate()
  assert.equal(
    native.incoming.length,
    4,
  )
  assert.equal(
    loadHydra({ hydraId }).state.cards[HYDRA_CARD]?.compaction?.operations.at(-1)?.state,
    'done',
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
  console.log('High context stays intact until the owner requests compaction')
} finally {
  host.close()
}

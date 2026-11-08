import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { commands } from '#app/cli.ts'
import { createHost } from '#app/host.ts'
import { loadHydra } from '#app/store.ts'
import { withWriter } from '#app/writer.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import type { QueryFn } from '#workers/claude.ts'
import { claudeNative } from '#workers/fixtures/claude-native.ts'
import { claudeRecording } from '#test-harness/fake-agents.ts'
import { settle } from '#test-harness/child-fixture.ts'

const hydraId = 'quiet-context'
let native = claudeNative()
const result = claudeRecording.turn.find(message => message.type === 'result')
assert.ok(result?.type === 'result' && result.subtype === 'success')
await commands.hydra([
  'create',
  hydraId,
])
const state = () => loadHydra({ hydraId }).state
const addNote = ({ text }: { text: string }) => withWriter({
  hydraId,
  fn: ({ writer }) => writer.append({
    event: {
      v: 1,
      id: randomUUID(),
      seq: writer.state.seq + 1,
      at: new Date().toISOString(),
      actor: 'pnyx',
      cardId: HYDRA_CARD,
      type: 'hydra.helper-finished',
      data: {
        batch: randomUUID(),
        outcomes: [
          {
            task: 'work',
            status: 'handled',
            summary: text,
          },
        ],
      },
    },
  }),
})

const query: QueryFn = ({ ...options }) => {
  if (native.closed()) {
    native = claudeNative()
  }

  return native.query(options)
}

const host = createHost({
  hydraId,
  query,
  changed: () => {},
  wakeDelay: 60_000,
  stallDelay: 60_000,
})
const finished = ({ messages }: { messages: number }) => settle({
  what: 'native turn to settle',
  check: () => native.delivered() >= messages && state().cards[HYDRA_CARD]?.sessionActivity === 'finished',
})
const input = ({ count }: { count: number }) => settle({
  what: 'Hydra input',
  check: () => native.incoming.length === count,
})

try {
  addNote({ text: 'Initial synthetic outcome' })
  await host.hydra({
    id: 'first',
    text: 'Read the context',
    actor: 'cli',
  })
  await input({ count: 1 })
  assert.match(
    JSON.stringify(native.incoming[0]),
    /Initial synthetic outcome/,
  )
  native.send({
    message: {
      ...result,
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['Synthetic failure'],
      uuid: randomUUID(),
      user_message_uuid: native.incoming[0]!.uuid,
      queued_turn_count: 0,
    },
  })
  await settle({
    what: 'failed native session to close',
    check: () => native.closed()
    && state().cards[HYDRA_CARD]?.sessionActivity === 'finished',
  })
  assert.equal(
    state().contextNotes?.length,
    1,
  )
  const failed = native

  await host.hydra({
    id: 'compact',
    text: '/compact',
    actor: 'cli',
  })
  await settle({
    what: 'compaction session input',
    check: () => native !== failed && native.incoming.length === 1,
  })
  assert.doesNotMatch(
    JSON.stringify(native.incoming[0]),
    /Since your last turn|Initial synthetic outcome/,
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
      user_message_uuid: native.incoming[0]!.uuid,
      queued_turn_count: 0,
    },
  })
  await finished({ messages: 3 })
  assert.equal(
    state().contextNotes?.length,
    1,
    'compaction must preserve notes retained after failure',
  )

  await host.hydra({
    id: 'retry',
    text: 'Retry the turn',
    actor: 'cli',
  })
  await input({ count: 2 })
  assert.match(
    JSON.stringify(native.incoming[1]),
    /Initial synthetic outcome/,
  )
  addNote({ text: 'Outcome during active turn' })
  await host.hydra({
    id: 'joined',
    text: 'An owner message joins',
    actor: 'cli',
  })
  await input({ count: 3 })
  assert.doesNotMatch(
    JSON.stringify(native.incoming[2]),
    /Since your last turn|Outcome during active turn/,
  )
  native.send({
    message: {
      ...result,
      uuid: randomUUID(),
      user_message_uuid: native.incoming[2]!.uuid,
      queued_turn_count: 0,
    },
  })
  await finished({ messages: 4 })
  assert.deepEqual(
    state().contextNotes?.map(note => note.text),
    ['Routine helper, work: Outcome during active turn'],
  )

  await host.hydra({
    id: 'next',
    text: 'Start the next turn',
    actor: 'cli',
  })
  await input({ count: 4 })
  assert.match(
    JSON.stringify(native.incoming[3]),
    /Outcome during active turn/,
  )
  assert.doesNotMatch(
    JSON.stringify(native.incoming[3]),
    /Initial synthetic outcome/,
  )
  native.send({
    message: {
      ...result,
      uuid: randomUUID(),
      user_message_uuid: native.incoming[3]!.uuid,
      queued_turn_count: 0,
    },
  })
  await finished({ messages: 5 })
  assert.deepEqual(
    state().contextNotes,
    [],
  )
  console.log('Failed turns retain context and active-turn joins defer new notes')
} finally {
  host.close()
}

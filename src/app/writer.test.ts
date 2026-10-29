import assert from 'node:assert/strict'
import { test } from 'node:test'
import { eventWriter } from './writer.ts'
import { emptyHydra, replay } from './reducer.ts'
import type { HydraEvent } from './model.ts'
import { readStream } from '#test-harness/streams.ts'

for (const name of [
  'lifecycle',
  'pinned-attention',
  'undo',
]) {
  test(
    `writer state matches cold replay without changing its input: ${name}`,
    () => {
      const initial = emptyHydra()
      const frozen = structuredClone(initial)
      const events: HydraEvent[] = []
      const writer = eventWriter({
        state: initial,
        dir: '',
        hydraId: 'default',
        onAppend: ({ event }) => events.push(structuredClone(event)),
      })

      for (const event of readStream({ name })) {
        if (event.seq > writer.state.seq && !Object.hasOwn(
          writer.state.eventIds,
          event.id,
        )) {
          writer.append({
            event,
            effects: false,
          })
        }
      }

      assert.deepEqual(
        initial,
        frozen,
      )
      assert.deepEqual(
        writer.state,
        replay({
          state: emptyHydra(),
          events,
        }),
      )
      assert.doesNotThrow(() => structuredClone(writer.state))
    },
  )
}

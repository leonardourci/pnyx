import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { withWriter } from '#app/writer.ts'
import { applyDecision } from '#app/decision.ts'
import { loadHydra, reloadHydra } from '#app/store.ts'
import { readEvents } from '#app/event-log.ts'
import { decidePush } from './push.ts'

for (const adapter of [
  'hooks',
  'paseo',
  'transcript',
  'pnyx',
  'firstmate',
]) {
  test(
    `repeated ${adapter} reports preserve the same presence rule after reload`,
    () => {
      process.env.PNYX_HOME = mkdtempSync(join(
        tmpdir(),
        'pnyx-observation-presence-',
      ))
      const initial = '2026-11-13T10:00:00.000Z'
      const later = '2026-11-13T10:30:00.000Z'
      const push = ({
        at,
        id,
        adapter,
      }: {
        at: string
        id: string
        adapter: string
      }) => withWriter({
        hydraId: 'lab',
        create: true,
        fn: ({ writer }) => applyDecision({
          writer,
          decision: decidePush({
            state: writer.state,
            key: 'worker',
            newCardId: 'worker',
            input: {
              title: 'Worker',
              activity: 'working',
              agent: {
                provider: 'claude-code',
                sessionId: 'fixture',
              },
              source: {
                adapter,
                objectId: 'fixture',
                observedAt: at,
              },
            },
            meta: {
              actor: 'test',
              id,
              at,
            },
          }),
        }),
      })
      push({
        at: initial,
        id: 'first',
        adapter: 'hooks',
      })
      push({
        at: initial,
        id: 'adapter',
        adapter,
      })
      push({
        at: later,
        id: 'repeat',
        adapter,
      })
      const expected = [
        'hooks',
        'paseo',
        'transcript',
      ].includes(adapter) ? later : initial
      const state = loadHydra({ hydraId: 'lab' }).state
      assert.equal(
        Object.values(state.sessions!)[0]!.lastSeen,
        expected,
      )
      assert.equal(
        readEvents({
          hydraId: 'lab',
          ids: ['repeat'],
        }).length,
        0,
      )
      reloadHydra({ hydraId: 'lab' })
      assert.equal(
        Object.values(loadHydra({ hydraId: 'lab' }).state.sessions!)[0]!.lastSeen,
        expected,
      )
    },
  )
}

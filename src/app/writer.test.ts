import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
    t => {
      const dir = mkdtempSync(join(
        tmpdir(),
        'pnyx-writer-',
      ))
      t.after(() => rmSync(
        dir,
        {
          recursive: true,
          force: true,
        },
      ))
      const initial = emptyHydra()
      const frozen = structuredClone(initial)
      const events: HydraEvent[] = []
      const writer = eventWriter({
        state: initial,
        dir,
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

test(
  'recursive declarations preserve lifecycle placement and cold replay',
  t => {
    const dir = mkdtempSync(join(
      tmpdir(),
      'pnyx-writer-lifecycle-',
    ))
    t.after(() => rmSync(
      dir,
      {
        recursive: true,
        force: true,
      },
    ))
    const initial = replay({
      state: emptyHydra(),
      events: readStream({ name: 'lifecycle' }),
    })
    const old = initial.cards.c1!
    const next = initial.cards.c2!
    old.links = []
    next.links = []
    old.tracking = 'declared'
    old.status = {
      state: 'working',
      id: 'working',
      at: '2026-10-29T11:00:00Z',
      actor: 'test',
      note: 'Worker assigned',
    }
    old.sessionIds = ['worker']
    old.agent = {
      provider: 'claude',
      sessionId: 'worker',
    }
    next.tracking = 'declared'
    next.column = 'queued'
    delete next.parentId
    delete next.outcome
    initial.sessions = {
      worker: {
        id: 'worker',
        originCardId: old.id,
        taskId: old.id,
        agent: old.agent,
        attention: [],
        sourceRefs: [],
        activity: 'working',
      },
    }
    const original = structuredClone(initial)
    const events: HydraEvent[] = []
    const writer = eventWriter({
      state: initial,
      dir,
      hydraId: 'default',
      onAppend: ({ event }) => events.push(structuredClone(event)),
    })
    writer.append({
      event: {
        v: 1,
        id: 'reassign',
        seq: writer.state.seq + 1,
        at: '2026-10-29T12:00:00Z',
        actor: 'test',
        cardId: 'c1',
        type: 'task.session',
        data: {
          session: 'worker',
          before: 'c1',
          after: 'c2',
          working: true,
        },
      },
    })
    assert.equal(
      writer.state.cards.c1?.status?.state,
      'paused',
    )
    assert.equal(
      writer.state.cards.c2?.status?.state,
      'working',
    )
    assert.equal(
      writer.state.cards.c1?.column,
      'parked',
    )
    assert.equal(
      writer.state.cards.c2?.column,
      'in_progress',
    )
    assert.equal(
      writer.state.sessions?.worker?.taskId,
      'c2',
    )
    assert.equal(
      writer.state.cards.c1?.agent,
      undefined,
    )
    assert.equal(
      writer.state.cards.c2?.agent?.sessionId,
      'worker',
    )
    assert.deepEqual(
      events.filter(event => event.type === 'card.moved').map(event => event.cardId),
      [
        'c1',
        'c2',
      ],
    )
    assert.deepEqual(
      initial,
      original,
    )
    assert.deepEqual(
      writer.state,
      replay({
        state: initial,
        events,
      }),
    )
    assert.doesNotThrow(() => structuredClone(writer.state))
  },
)

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decidePush } from '../src/core/decide.ts'
import { emptyHydra, reduce, replay } from '../src/core/reducer.ts'
import { cardState } from '../web/src/hydra/view.ts'
import type { Card, HydraEvent } from '../src/core/model.ts'

const at = '2026-10-15T00:00:00Z'
const now = Date.parse('2026-10-15T02:00:00Z')
const task: Card = {
  id: 'task-test',
  key: 'test',
  title: 'Test',
  column: 'queued',
  workspace: 'unassigned',
  tags: [],
  attention: [],
  links: [],
  sourceRefs: [],
  createdSeq: 1,
  updatedSeq: 1,
  revision: 1,
  updatedAt: at,
}
const agent = {
  provider: 'claude-code',
  sessionId: 'test',
}

test(
  'cards distinguish not started, working, finished, stopped, and unanswered asks',
  () => {
    const state = ({ card }: { card: Partial<Card> }) =>
      cardState({
        card: {
          ...task,
          ...card,
        },
        now,
      })
    assert.equal(
      state({ card: {} }).text,
      'not started',
    )
    assert.equal(
      state({
        card: {
          agent,
          activity: 'working',
        },
      }).text,
      'working',
    )
    assert.equal(
      state({
        card: {
          agent,
          activity: 'finished',
        },
      }).text,
      'finished its turn',
    )
    assert.equal(
      state({
        card: {
          agent,
          activity: 'ended',
          stoppedAt: at,
        },
      }).text,
      'stopped · 2h ago',
    )
    assert.equal(
      state({
        card: {
          attention: [
            {
              kind: 'question',
              key: 'q',
              blocking: true,
            },
          ],
        },
      }).text,
      'asks',
    )
    assert.equal(
      state({
        card: {
          attention: [
            {
              kind: 'question',
              key: 'q',
              blocking: true,
              answered: 'reply',
            },
          ],
        },
      }).text,
      'not started',
    )
  },
)

test(
  'Done labels count down only in the last six hours and respect card and Hydra delays',
  () => {
    const label = ({
      hours,
      override,
    }: {
      hours?: number
      override?: number
    }) =>
      cardState({
        card: {
          ...task,
          doneAt: at,
          doneAfterHours: override,
        },
        hours,
        now,
      })
    assert.equal(
      label({}).text,
      'done · 2h ago',
    )
    assert.equal(
      label({ hours: 5 }).text,
      'hidden in 3h',
    )
    assert.equal(
      label({
        hours: 0,
        override: 5,
      }).text,
      'hidden in 3h',
    )
    assert.equal(
      label({
        hours: 5,
        override: 0,
      }).text,
      'done · 2h ago',
    )
    assert.equal(
      label({ hours: 8 }).text,
      'hidden in 6h',
    )
    assert.equal(
      label({ hours: 2.5 }).text,
      'hidden in 30m',
    )
  },
)

test(
  'new observed cards have random IDs, upserts keep them, and replay keeps stop time through edits',
  () => {
    const input = {
      title: 'Worker',
      agent,
      activity: 'ended',
      source: {
        adapter: 'hooks',
        objectId: 'test',
      },
    }
    const meta = {
      at,
      actor: 'test',
    }
    const first = decidePush({
      state: emptyHydra(),
      key: 'work',
      input,
      meta,
    })
    const second = decidePush({
      state: emptyHydra(),
      key: 'work',
      input,
      meta,
    })
    assert.ok('event' in first && 'event' in second)
    assert.match(
      first.event.cardId,
      /^task-[0-9a-f-]{36}$/,
    )
    assert.notEqual(
      first.event.cardId,
      second.event.cardId,
    )
    const state = reduce({
      state: emptyHydra(),
      event: first.event,
    })
    const edit = decidePush({
      state,
      key: 'work',
      input: { title: 'Renamed' },
      meta: {
        ...meta,
        at: new Date(now).toISOString(),
      },
    })
    assert.ok('event' in edit)
    assert.equal(
      edit.event.cardId,
      first.event.cardId,
    )
    const events: HydraEvent[] = [
      first.event,
      edit.event,
    ]
    const replayed = replay({
      state: emptyHydra(),
      events,
    })
    assert.equal(
      replayed.cards[first.event.cardId]?.stoppedAt,
      at,
    )
    assert.equal(
      cardState({
        card: replayed.cards[first.event.cardId]!,
        now,
      }).text,
      'stopped · 2h ago',
    )
  },
)

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decidePush } from '../src/core/decide.ts'
import { emptyHydra, reduce, replay } from '../src/core/reducer.ts'
import { cardState } from '../web/src/hydra/view.ts'
import { lifecycleStage } from '../src/core/lifecycle.ts'
import { INTERRUPTED } from '../src/core/tasks.ts'
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
  'a question waiting on Hydra is not the owner\'s, and a turn cut short by a restart moves nothing',
  () => {
    const ask = ({ audience }: { audience: 'hydra' | 'owner' }) => ({
      id: 'ask-1',
      at,
      actor: 'worker:task-test',
      audience,
      question: 'Which scope?',
    })
    const shown = ({ card }: { card: Partial<Card> }) => cardState({
      card: {
        ...task,
        agent,
        ...card,
      },
      now,
    }).kind
    assert.deepEqual(
      [
        shown({
          card: {
            activity: 'finished',
            asks: [ask({ audience: 'hydra' })],
          },
        }),
        shown({
          card: {
            activity: 'working',
            asks: [ask({ audience: 'hydra' })],
          },
        }),
        shown({
          card: {
            activity: 'finished',
            asks: [ask({ audience: 'owner' })],
          },
        }),
      ],
      [
        'asks-hydra',
        'working',
        'asks',
      ],
    )
    assert.equal(
      lifecycleStage({
        card: {
          ...task,
          asks: [ask({ audience: 'hydra' })],
        },
      }),
      undefined,
    )
    const interrupted: Card = {
      ...task,
      attention: [
        {
          kind: 'interrupted',
          key: INTERRUPTED,
          blocking: true,
        },
      ],
    }
    assert.equal(
      lifecycleStage({ card: interrupted }),
      undefined,
    )
    assert.equal(
      lifecycleStage({
        card: {
          ...interrupted,
          attention: [
            ...interrupted.attention,
            {
              kind: 'question',
              key: 'hook:tool:AskUserQuestion',
              blocking: true,
            },
          ],
        },
      }),
      'needs_you',
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
  'an upsert keeps an observed card\'s ID, and replay keeps its stop time through edits',
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
    assert.ok('event' in first)
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

test(
  'worker needs_you and blocked notes are flags In progress, while owner gates take precedence',
  () => {
    for (const state of [
      'needs_you',
      'blocked',
    ] as const) {
      const card: Card = {
        ...task,
        status: {
          id: 'note',
          at,
          actor: 'worker:test',
          state,
          note: 'Waiting on checks',
        },
      }
      assert.equal(
        lifecycleStage({ card }),
        'in_progress',
      )
      assert.equal(
        card.status?.state,
        state,
      )
      assert.equal(
        lifecycleStage({
          card: {
            ...card,
            permissions: [
              {
                id: 'permission',
                session: 'test',
                status: 'pending',
                at,
                tool: 'Shell',
                input: {},
              },
            ],
          },
        }),
        'needs_you',
      )
    }
  },
)

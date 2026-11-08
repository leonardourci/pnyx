import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emptyHydra, reduce, replay } from '#app/reducer.ts'
import { hydraConfig } from '#hydra/config.ts'
import { migrateColumns } from './column-rules.ts'
import { cardFacts, placeCard } from './columns.ts'
import type { HydraEvent } from '#app/model.ts'

test(
  'completed held tasks leave Queued under the default rules',
  () => {
    const state = reduce({
      state: emptyHydra(),
      event: {
        v: 1,
        id: 'created',
        seq: 1,
        at: '2026-11-01T00:00:00Z',
        actor: 'web',
        cardId: 'obsolete',
        type: 'task.created',
        data: {
          key: 'obsolete',
          title: 'Superseded work',
          hold: 'Discuss before starting',
        },
      },
    })
    const card = state.cards.obsolete!
    card.status = {
      id: 'completed',
      at: '2026-11-01T01:00:00Z',
      actor: 'hydra',
      state: 'done',
      note: 'Superseded by another task',
    }
    assert.equal(
      placeCard({
        card: cardFacts({
          card,
          state,
        }),
        columns: hydraConfig({ state }).columns,
      }),
      'done',
    )
  },
)

test(
  'upgrading default hold rules moves only tasks still in their old rule destination',
  () => {
    const config = structuredClone(hydraConfig({ state: emptyHydra() }))
    const queued = config.columns.find(column => column.role === 'queued')!
    const done = config.columns.find(column => column.role === 'done')!
    queued.id = 'custom:backlog'
    queued.title = 'Later'
    queued.rule = [
      [
        '!owner-question',
        '!reminder-due',
        'held',
      ],
      [
        '!owner-question',
        '!reminder-due',
        '!done',
        'queued',
      ],
      [
        '!owner-question',
        '!reminder-due',
        '!done',
        '!held',
        '!queued',
        'worker:none',
      ],
    ]
    done.rule = [
      [
        '!owner-question',
        '!reminder-due',
        '!held',
        'done',
      ],
    ]
    config.columns.push({
      id: 'custom:manual',
      title: 'Manual',
      rule: [],
    })
    const events: HydraEvent[] = [
      {
        v: 1,
        id: 'configured',
        seq: 1,
        at: '2026-11-01T00:00:00Z',
        actor: 'web',
        cardId: '$board',
        type: 'board.configured',
        data: config,
      },
    ]
    let state = replay({
      state: emptyHydra(),
      events,
    })

    for (const id of [
      'obsolete',
      'manual',
      'unfinished',
    ]) {
      const created: HydraEvent = {
        v: 1,
        id: `create:${id}`,
        seq: state.seq + 1,
        at: '2026-11-01T00:00:00Z',
        actor: 'web',
        cardId: id,
        type: 'task.created',
        data: {
          key: id,
          title: id,
          hold: 'Discuss first',
        },
      }
      events.push(created)
      state = reduce({
        state,
        event: created,
      })
    }

    for (const id of [
      'obsolete',
      'manual',
    ]) {
      const completed: HydraEvent = {
        v: 1,
        id: `complete:${id}`,
        seq: state.seq + 1,
        at: '2026-11-01T01:00:00Z',
        actor: 'hydra',
        cardId: id,
        type: 'task.declared',
        data: {
          state: 'done',
          note: 'Superseded',
        },
      }
      events.push(completed)
      state = reduce({
        state,
        event: completed,
      })
    }

    const moved: HydraEvent = {
      v: 1,
      id: 'manual-placement',
      seq: state.seq + 1,
      at: '2026-11-01T02:00:00Z',
      actor: 'web',
      cardId: 'manual',
      type: 'card.moved',
      data: {
        before: 'custom:backlog',
        after: 'custom:manual',
      },
    }
    events.push(moved)
    state = reduce({
      state,
      event: moved,
    })
    const decision = migrateColumns({
      state,
      meta: {
        id: 'upgrade',
        actor: 'pnyx',
        at: '2026-11-02T00:00:00Z',
      },
    })
    assert.ok('event' in decision)
    const after = reduce({
      state,
      event: decision.event,
    })
    assert.equal(
      after.cards.obsolete?.column,
      'done',
    )
    assert.equal(
      after.cards.obsolete?.doneAt,
      '2026-11-02T00:00:00Z',
    )
    assert.equal(
      after.cards.obsolete?.hold?.id,
      'create:obsolete',
    )
    assert.equal(
      after.cards.manual?.column,
      'custom:manual',
    )
    assert.equal(
      after.cards.unfinished?.column,
      'custom:backlog',
    )
    assert.equal(
      after.config?.columns[0]?.title,
      'Later',
    )
    assert.deepEqual(
      after.config?.columns.at(-1)?.rule,
      [],
    )
    assert.deepEqual(
      after,
      replay({
        state: emptyHydra(),
        events: [
          ...events,
          decision.event,
        ],
      }),
    )
    assert.deepEqual(
      migrateColumns({
        state: after,
        meta: {
          actor: 'pnyx',
          at: '2026-11-03T00:00:00Z',
        },
      }),
      { skipped: 'unchanged' },
    )

    const custom = structuredClone(state)
    custom.config!.columns[0]!.rule = [['held']]
    custom.config!.columns.find(column => column.role === 'done')!.rule = []
    assert.deepEqual(
      migrateColumns({
        state: custom,
        meta: {
          actor: 'pnyx',
          at: '2026-11-02T00:00:00Z',
        },
      }),
      { skipped: 'unchanged' },
    )

    const hidden = structuredClone(state)
    hidden.cards.obsolete!.hidden = true
    const hiddenUpgrade = migrateColumns({
      state: hidden,
      meta: {
        actor: 'pnyx',
        at: '2026-11-02T00:00:00Z',
      },
    })
    assert.ok('event' in hiddenUpgrade)
    const hiddenAfter = reduce({
      state: hidden,
      event: hiddenUpgrade.event,
    })
    assert.equal(
      hiddenAfter.cards.obsolete?.hidden,
      true,
    )
    assert.equal(
      hiddenAfter.cards.obsolete?.column,
      'custom:backlog',
    )

    const automatic = structuredClone(state)
    automatic.cards.obsolete!.automaticTask = true
    const automaticUpgrade = migrateColumns({
      state: automatic,
      meta: {
        actor: 'pnyx',
        at: '2026-11-02T00:00:00Z',
      },
    })
    assert.ok('event' in automaticUpgrade)
    const automaticAfter = reduce({
      state: automatic,
      event: automaticUpgrade.event,
    })
    assert.equal(
      automaticAfter.cards.obsolete?.column,
      'custom:backlog',
    )
    assert.equal(
      automaticAfter.cards.obsolete?.hidden,
      true,
    )

    const linked = structuredClone(state)
    linked.config!.hydra.kind = 'firstmate'
    const linkedUpgrade = migrateColumns({
      state: linked,
      meta: {
        actor: 'pnyx',
        at: '2026-11-02T00:00:00Z',
      },
    })
    assert.ok('event' in linkedUpgrade)
    assert.equal(
      reduce({
        state: linked,
        event: linkedUpgrade.event,
      })
        .cards.obsolete?.column,
      'custom:backlog',
    )
  },
)

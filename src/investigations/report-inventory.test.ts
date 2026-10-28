import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hydraEvent } from '../hydra/hydra.ts'
import { emptyHydra, reduce, replay } from '../app/reducer.ts'
import { doneDeadline } from '../tasks/retention-rules.ts'
import { openDecisions } from '../tasks/decisions.ts'
import type { HydraChange, HydraEvent } from '../app/model.ts'
import { reportReviewGaps } from './inventory.ts'

const at = '2026-10-23T12:00:00Z'

test(
  'legacy report logs replay unchanged, block expiry until reviewed, and never lose archived-origin choices',
  () => {
    let state = emptyHydra()
    const events: HydraEvent[] = []

    const append = ({
      cardId,
      change,
    }: {
      cardId: string
      change: Pick<HydraChange, 'type' | 'data'>
    }) => {
      const decision = hydraEvent({
        state,
        cardId,
        change,
        meta: {
          at,
          actor: 'hydra',
        },
      })
      assert.ok('event' in decision)
      events.push(decision.event)
      state = reduce({
        state,
        event: decision.event,
      })
    }

    append({
      cardId: 'origin',
      change: {
        type: 'task.created',
        data: {
          key: 'origin',
          title: 'Report',
          kind: 'investigation',
          column: 'done',
        },
      },
    })
    append({
      cardId: 'origin',
      change: {
        type: 'task.report',
        data: { text: 'A historical report.' },
      },
    })
    const reportId = state.cards.origin!.report!.id
    assert.equal(
      state.cards.origin!.report!.review,
      undefined,
    )
    assert.equal(
      doneDeadline({ state }),
      undefined,
    )
    assert.equal(
      reportReviewGaps({
        state,
        card: state.cards.origin!,
      }).length,
      1,
    )
    assert.deepEqual(
      replay({
        state: emptyHydra(),
        events,
      }),
      state,
    )
    append({
      cardId: 'origin',
      change: {
        type: 'task.report-reviewed',
        data: {
          report: reportId,
          calls: [],
        },
      },
    })
    assert.ok(doneDeadline({ state }))
    append({
      cardId: 'call',
      change: {
        type: 'task.created',
        data: {
          key: 'call',
          title: 'Gated work',
          column: 'done',
        },
      },
    })
    append({
      cardId: 'call',
      change: {
        type: 'task.asked',
        data: {
          id: 'ask-history',
          audience: 'owner',
          question: 'Retain history?',
          origin: {
            task: 'origin',
            report: reportId,
          },
        },
      },
    })
    assert.equal(
      reportReviewGaps({
        state,
        card: state.cards.origin!,
      }).length,
      1,
    )
    append({
      cardId: 'origin',
      change: {
        type: 'task.report-reviewed',
        data: {
          report: reportId,
          calls: [
            {
              task: 'call',
              ask: 'ask-history',
            },
          ],
        },
      },
    })
    append({
      cardId: 'origin',
      change: {
        type: 'task.visibility',
        data: {
          before: false,
          after: true,
        },
      },
    })
    assert.equal(
      doneDeadline({ state }),
      undefined,
    )
    const hidden: HydraEvent = {
      v: 1,
      seq: state.seq + 1,
      id: 'legacy-hide',
      at,
      actor: 'test',
      cardId: 'call',
      type: 'task.visibility',
      data: {
        before: false,
        after: true,
      },
    }
    events.push(hidden)
    state = reduce({
      state,
      event: hidden,
    })
    const rebuilt = replay({
      state: emptyHydra(),
      events,
    })
    assert.deepEqual(
      rebuilt,
      state,
    )
    assert.deepEqual(
      openDecisions({ state: rebuilt }).map(item => item.id),
      ['ask-history'],
    )
    assert.equal(
      rebuilt.cards.origin!.hidden,
      true,
    )
    assert.equal(
      rebuilt.cards.call!.asks![0]!.origin!.report,
      reportId,
    )
  },
)

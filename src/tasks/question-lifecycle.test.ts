import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emptyHydra, reduce } from '#app/reducer.ts'
import type { HydraEvent } from '#app/model.ts'
import type { Ask, Card } from './model.ts'
import { reconcileAsks, mergeApproval, canonicalMergeQuestion } from '#tasks/delivery/merge-questions.ts'
import { activeAsks } from './ask-state.ts'

const at = '2026-11-01T12:00:00.000Z'
const url = 'https://github.com/example/project/pull/12'

test(
  'replaying a deferral leaves a worker question active',
  () => {
    const {
      state,
      card,
      ask,
    } = lab()
    ask.audience = 'hydra'
    const deferred = reduce({
      state,
      event: {
        v: 1,
        seq: 1,
        id: 'invalid-worker-deferral',
        at,
        actor: 'pnyx',
        cardId: card.id,
        type: 'task.ask.deferred',
        data: {
          ask: ask.id,
          until: '2099-11-10T12:00:00.000Z',
        },
      },
    })
    assert.equal(
      deferred.cards[card.id]?.asks?.[0]?.deferredUntil,
      undefined,
    )
    assert.equal(
      activeAsks({ card: deferred.cards[card.id]! })[0]?.id,
      'ask-decision',
    )
  },
)

test(
  'Undo preserves a future Later date and clears an expired deferral immediately',
  () => {
    const {
      state,
      card,
      ask,
    } = lab()
    const deferred = reduce({
      state,
      event: {
        v: 1,
        seq: 1,
        id: 'defer',
        at,
        actor: 'web',
        cardId: card.id,
        type: 'task.ask.deferred',
        data: {
          ask: ask.id,
          until: '2026-11-02T12:00:00.000Z',
          fromMessage: {
            id: 'owner-later',
            text: 'Later until November 2 at noon UTC.',
            at,
          },
        },
      },
    })
    const answered = reduce({
      state: deferred,
      event: {
        v: 1,
        seq: 2,
        id: 'first-answer',
        at: '2026-11-01T12:01:00.000Z',
        actor: 'web',
        cardId: card.id,
        type: 'hydra.message',
        data: {
          task: card.id,
          hydra: 'lab',
          action: 'send',
          text: 'Use the compact format.',
          answers: ask.id,
        },
      },
    })
    const undone = reduce({
      state: answered,
      event: {
        v: 1,
        seq: 3,
        id: 'first-undo',
        at: '2026-11-01T12:02:00.000Z',
        actor: 'web',
        cardId: card.id,
        type: 'task.ask.reopened',
        data: {
          ask: ask.id,
          answer: 'first-answer',
        },
      },
    })
    assert.equal(
      undone.cards[card.id]?.asks?.[0]?.deferredUntil,
      '2026-11-02T12:00:00.000Z',
    )
    assert.deepEqual(
      activeAsks({ card: undone.cards[card.id]! }),
      [],
    )
    const answeredAgain = reduce({
      state: undone,
      event: {
        v: 1,
        seq: 4,
        id: 'second-answer',
        at: '2026-11-03T12:01:00.000Z',
        actor: 'web',
        cardId: card.id,
        type: 'hydra.message',
        data: {
          task: card.id,
          hydra: 'lab',
          action: 'send',
          text: 'Use the expanded format.',
          answers: ask.id,
        },
      },
    })
    const reopened = reduce({
      state: answeredAgain,
      event: {
        v: 1,
        seq: 5,
        id: 'second-undo',
        at: '2026-11-03T12:02:00.000Z',
        actor: 'web',
        cardId: card.id,
        type: 'task.ask.reopened',
        data: {
          ask: ask.id,
          answer: 'second-answer',
        },
      },
    })
    assert.equal(
      reopened.cards[card.id]?.asks?.[0]?.deferredUntil,
      undefined,
    )
    assert.equal(
      reopened.cards[card.id]?.asks?.[0]?.deferredFromMessage,
      undefined,
    )
    assert.equal(
      activeAsks({ card: reopened.cards[card.id]! })[0]?.id,
      'ask-decision',
    )
  },
)

type Change = {
  [Kind in HydraEvent['type']]: Pick<Extract<HydraEvent, { type: Kind }>, 'type' | 'data'>
}[HydraEvent['type']]

function lab() {
  const ask: Ask = {
    id: 'ask-decision',
    at,
    actor: 'hydra',
    audience: 'owner',
    question: 'Authorize the production setting and removal?',
  }
  const card: Card = {
    id: 'task-choice',
    key: 'choice',
    title: 'Review the setting',
    workspace: '',
    column: 'queued',
    tags: [],
    attention: [],
    links: [],
    sourceRefs: [],
    revision: 1,
    createdSeq: 1,
    updatedSeq: 1,
    updatedAt: at,
    asks: [ask],
  }
  const state = emptyHydra()
  state.cards[card.id] = card
  const reconcile = ({ ...change }: Change = {
    type: 'task.declared',
    data: {
      state: 'working',
      note: 'Unchanged work',
    },
  }) => reconcileAsks({
    state,
    event: {
      v: 1,
      seq: 2,
      id: 'event-change',
      at,
      actor: 'pnyx',
      cardId: card.id,
      ...change,
    },
  })

  return {
    state,
    card,
    ask,
    reconcile,
  }
}

test(
  'a merged related change does not settle a production or destructive decision',
  () => {
    const {
      card,
      reconcile,
    } = lab()
    card.links = [
      {
        kind: 'github_pr',
        url,
        state: 'merged',
      },
    ]
    assert.deepEqual(
      reconcile(),
      [],
    )
    card.status = {
      id: 'merge-done',
      at,
      actor: 'pnyx',
      state: 'done',
      note: 'Pull request merged',
    }
    assert.deepEqual(
      reconcile({
        type: 'task.declared',
        data: card.status,
      }),
      [],
    )
  },
)

test(
  'finishing discovery or asking on an already ended task preserves the decision',
  () => {
    const {
      card,
      reconcile,
    } = lab()
    card.kind = 'investigation'
    card.status = {
      id: 'report-done',
      at,
      actor: 'worker:research',
      state: 'done',
      note: 'Report complete',
    }
    assert.deepEqual(
      reconcile({
        type: 'task.declared',
        data: card.status,
      }),
      [],
    )
    card.kind = 'build'
    assert.deepEqual(
      reconcile({
        type: 'task.asked',
        data: card.asks![0],
      }),
      [],
    )
  },
)

test(
  'explicit completion closes ordinary questions while report origins and current Go holds remain owed',
  () => {
    const {
      card,
      ask,
      reconcile,
    } = lab()
    card.status = {
      id: 'finished',
      at,
      actor: 'hydra',
      state: 'done',
      note: 'Work finished',
    }
    const event: Change = {
      type: 'task.declared',
      data: card.status,
    }
    assert.equal(
      reconcile(event)[0]?.type,
      'task.ask.closed',
    )
    ask.origin = {
      task: 'research',
      report: 'report-1',
    }
    assert.deepEqual(
      reconcile(event),
      [],
    )
    delete ask.origin
    ask.kind = 'go'
    ask.hold = {
      id: 'hold-1',
      at,
      actor: 'web',
      reason: 'Discuss first',
    }
    card.hold = ask.hold
    assert.deepEqual(
      reconcile(event),
      [],
    )
  },
)

test(
  'a merge question closes when its linked pull request settles',
  () => {
    const {
      card,
      ask,
      reconcile,
    } = lab()
    ask.kind = 'merge'
    ask.url = url
    card.links = [
      {
        kind: 'github_pr',
        url,
        state: 'closed',
      },
    ]
    assert.equal(
      reconcile()[0]?.type,
      'task.ask.closed',
    )
  },
)

test(
  'one review approval covers the same change linked from several tasks',
  () => {
    const {
      state,
      card,
      ask,
      reconcile,
    } = lab()
    const other = structuredClone(card)
    other.id = 'task-implementation'
    other.asks = []
    other.links = [
      {
        kind: 'github_pr',
        url,
        state: 'open',
        draft: false,
      },
    ]
    other.landing = {
      landing: 'pr',
      merge: 'owner',
    }
    state.cards[other.id] = other
    ask.kind = 'merge'
    ask.url = url
    card.links = other.links
    card.landing = other.landing
    other.asks = [structuredClone(ask)]
    card.asks = []
    assert.deepEqual(
      reconcile({
        type: 'card.linked',
        data: {
          url,
          before: null,
          after: card.links[0]!,
        },
      }),
      [],
    )
    other.asks[0]!.answered = 'owner-answer'
    other.asks[0]!.choice = 'Merge'
    assert.equal(
      mergeApproval({
        state,
        card,
        url,
      })?.answered,
      'owner-answer',
    )
  },
)

test(
  'closing an older review alias leaves the newer pending approval canonical',
  () => {
    const {
      state,
      card,
      ask,
    } = lab()
    ask.kind = 'merge'
    ask.url = url
    const current = structuredClone(card)
    current.id = 'task-current-review'
    const pending = current.asks![0]!
    pending.id = 'ask-current-review'
    pending.at = '2026-11-01T12:20:00.000Z'
    state.cards[current.id] = current
    ask.closed = {
      id: 'retired-alias',
      at: '2026-11-01T12:30:00.000Z',
      reason: 'Task ended',
      evidence: 'finished-alias',
    }
    const canonical = canonicalMergeQuestion({
      state,
      card,
      url,
    })
    assert.equal(
      canonical?.card.id,
      current.id,
    )
    assert.equal(
      canonical?.ask.id,
      pending.id,
    )
    assert.equal(
      canonical?.ask.closed,
      undefined,
    )
    assert.equal(
      mergeApproval({
        state,
        card,
        url,
      }),
      undefined,
    )
  },
)

test(
  'legacy duplicate review questions retain the latest explicit owner decision',
  () => {
    const {
      state,
      card,
      ask,
    } = lab()
    ask.kind = 'merge'
    ask.url = url
    ask.choice = 'Hold'
    ask.answered = 'held'
    ask.answeredAt = '2026-11-01T12:10:00.000Z'
    const other = structuredClone(card)
    other.id = 'task-review'
    const approval = other.asks![0]!
    approval.id = 'ask-reviewed'
    approval.choice = 'Merge'
    approval.answered = 'approved'
    approval.answeredAt = '2026-11-01T12:20:00.000Z'
    state.cards[other.id] = other
    assert.equal(
      mergeApproval({
        state,
        card,
        url,
      })?.answered,
      'approved',
    )
    ask.answeredAt = '2026-11-01T12:30:00.000Z'
    assert.equal(
      mergeApproval({
        state,
        card,
        url,
      }),
      undefined,
    )
    approval.closed = {
      id: 'closed-review',
      at: '2026-11-01T12:40:00.000Z',
      reason: 'Review task finished',
      evidence: 'task-done',
    }
    ask.choice = 'Merge'
    assert.equal(
      mergeApproval({
        state,
        card,
        url,
      }),
      undefined,
    )
  },
)

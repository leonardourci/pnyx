import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emptyHydra } from '#app/reducer.ts'
import type { Card } from '#tasks/model.ts'
import { reviewRequests, reviewState } from './review-requests.ts'
import type { Link } from '#tasks/delivery/model.ts'
import { openDecisions } from '#tasks/decisions.ts'
import { dueQuestionReminders } from '#tasks/question-reminders.ts'
import { chatDecisions } from '#web-hydra/chat-questions.ts'
import { cardStatus, waitingQuestions } from '#tasks/card-status.ts'
import { taskQuestions } from './task-question.ts'

const at = '2026-11-01T12:00:00.000Z'
const url = 'https://github.com/synthetic/review/pull/1'
const card: Card = {
  id: 'review-task',
  key: 'review',
  title: 'Review the response format',
  column: 'needs_you',
  workspace: '',
  attention: [],
  links: [
    {
      kind: 'github_pr',
      url,
      state: 'open',
      draft: false,
    },
  ],
  tags: [],
  sourceRefs: [],
  createdSeq: 1,
  updatedSeq: 1,
  revision: 1,
  updatedAt: at,
  asks: [
    {
      id: 'approval',
      at,
      actor: 'pnyx',
      audience: 'owner',
      kind: 'merge',
      url,
      question: 'Ready for review',
      options: [
        { label: 'Merge' },
        { label: 'Hold' },
      ],
    },
  ],
}

test(
  'linked tasks share the canonical review controls and their approval state',
  () => {
    const state = emptyHydra()
    state.cards[card.id] = structuredClone(card)
    const secondary = {
      ...structuredClone(card),
      id: 'secondary',
      key: 'secondary',
      asks: [],
    }
    state.cards[secondary.id] = secondary
    const request = reviewRequests({
      state,
      card: secondary,
    })[0]
    assert.ok(request)
    assert.equal(
      reviewState({ request }),
      'Ready for review',
    )
    request.ask.deferredUntil = '2099-11-10T12:00:00.000Z'
    assert.equal(
      reviewState({ request }),
      'Review later',
    )
    delete request.ask.deferredUntil
    assert.equal(
      request?.card.id,
      card.id,
    )
    assert.equal(
      request?.ask.id,
      'approval',
    )
    state.cards[card.id]!.asks![0]!.answered = 'owner-held'
    state.cards[card.id]!.asks![0]!.choice = 'Hold'
    assert.equal(
      reviewState({ request }),
      'Review on hold',
    )
    assert.equal(
      reviewRequests({
        state,
        card: secondary,
      })[0]?.ask.choice,
      'Hold',
    )
    state.cards[card.id]!.asks![0]!.choice = 'Merge'
    assert.equal(
      reviewState({ request }),
      'Merge approved',
    )
    request.link.mergeAttempt = {
      outcome: 'queued',
      head: 'a'.repeat(40),
      requestedAt: at,
    }
    assert.equal(
      reviewState({ request }),
      'Merge awaiting confirmation',
    )
    assert.equal(
      reviewRequests({
        state,
        card: secondary,
      })[0]?.ask.choice,
      'Merge',
    )
    state.cards[card.id]!.asks![0]!.closed = {
      id: 'settled',
      at,
      reason: 'Merged',
      evidence: url,
    }
    assert.deepEqual(
      reviewRequests({
        state,
        card: secondary,
      }),
      [],
    )
  },
)

test(
  'review controls require an open, ready pull request link',
  () => {
    const excluded: Link[] = [
      {
        ...card.links[0]!,
        draft: undefined,
      },
      {
        ...card.links[0]!,
        draft: true,
      },
      {
        ...card.links[0]!,
        state: 'closed',
      },
      {
        ...card.links[0]!,
        state: 'merged',
      },
      {
        ...card.links[0]!,
        state: undefined,
      },
      {
        ...card.links[0]!,
        kind: 'url',
      },
    ]

    for (const link of excluded) {
      assert.deepEqual(
        taskQuestions({
          card: {
            ...card,
            links: [link],
          },
        }).asks.map(ask => ask.id),
        ['approval'],
      )
      assert.deepEqual(
        reviewRequests({
          card: {
            ...card,
            links: [link],
          },
        }),
        [],
        JSON.stringify(link),
      )
    }
  },
)

test(
  'legacy duplicate review asks produce one waiting item, one reminder and one contextual chat control',
  () => {
    const state = emptyHydra()
    const original = structuredClone(card)
    original.asks![0]!.at = '2026-11-01T10:00:00.000Z'
    const secondary = {
      ...structuredClone(card),
      id: 'secondary',
      key: 'secondary',
    }
    secondary.asks![0]!.id = 'newer-approval'
    state.cards[original.id] = original
    state.cards[secondary.id] = secondary
    assert.equal(
      openDecisions({ state }).filter(item => item.kind === 'owner question').length,
      1,
    )
    assert.equal(
      dueQuestionReminders({
        state,
        now: Date.parse('2026-11-02T12:00:00.000Z'),
      }).length,
      1,
    )
    const contextual = chatDecisions({
      state,
      selectedTask: original.id,
    })
    assert.equal(
      contextual.length,
      1,
    )
    assert.equal(
      contextual[0]?.ask.id,
      'newer-approval',
    )
    assert.equal(
      contextual[0]?.card.id,
      secondary.id,
    )
    assert.equal(
      contextual[0]?.relatedTask?.id,
      original.id,
    )
    original.status = {
      id: 'blocked',
      at,
      actor: 'worker:review',
      state: 'blocked',
      note: 'The owner must review',
    }
    const blocked = chatDecisions({ state })
    assert.equal(
      blocked.length,
      1,
    )
    assert.equal(
      blocked[0]?.blocker,
      true,
    )
    assert.equal(
      blocked[0]?.relatedTask?.id,
      original.id,
    )
    delete original.status
    secondary.asks![0]!.answered = 'approved'
    secondary.asks![0]!.answeredAt = '2026-11-01T13:00:00.000Z'
    secondary.asks![0]!.choice = 'Merge'
    assert.deepEqual(
      waitingQuestions({
        card: original,
        cards: state.cards,
      }),
      [],
    )
    assert.equal(
      cardStatus({
        card: original,
        cards: state.cards,
      }).text,
      'no worker assigned',
    )
  },
)

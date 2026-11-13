import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emptyHydra, replay } from '#app/reducer.ts'
import type { HydraEvent } from '#app/model.ts'
import { hydraConfig } from '#hydra/config.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { recordedAnswers } from './ask-state.ts'

const AT = '2026-11-13T12:00:00.000Z'
const ANSWERED_AT = '2026-11-13T12:07:46.876Z'
const OWNER_MESSAGE = {
  id: 'owner-message',
  text: 'Clean up the questions not waiting for me',
  at: AT,
}

const askOn = ({
  card,
  seq,
}: {
  card: string
  seq: number
}): HydraEvent => ({
  v: 1,
  id: `ask:${card}`,
  seq,
  at: AT,
  actor: 'hydra',
  cardId: card,
  type: 'task.asked',
  data: {
    id: `ask-${card}`,
    audience: 'owner',
    question: 'Wait for the reset, or move the work to Codex now?',
  },
})

const answerFromMessage = ({
  card,
  seq,
}: {
  card: string
  seq: number
}): HydraEvent => ({
  v: 1,
  id: `answer:${card}`,
  seq,
  at: ANSWERED_AT,
  actor: 'hydra',
  cardId: card,
  type: 'hydra.message',
  data: {
    task: card,
    action: 'send',
    text: OWNER_MESSAGE.text,
    context: `Answers question ask-${card}`,
    answers: `ask-${card}`,
    fromMessage: OWNER_MESSAGE,
    hydra: 'hydra',
  },
})

test(
  'a Hydra-wide question answered from the owner’s message closes, so its recorded answer leaves the chat; a task’s stays',
  () => {
    const state = replay({
      state: emptyHydra(),
      events: [
        {
          v: 1,
          id: 'configured',
          seq: 1,
          at: AT,
          actor: 'web',
          cardId: '$board',
          type: 'board.configured',
          data: hydraConfig({ state: emptyHydra() }),
        },
        {
          v: 1,
          id: 'create:task',
          seq: 2,
          at: AT,
          actor: 'hydra',
          cardId: 'task',
          type: 'task.created',
          data: {
            key: 'task',
            title: 'Fix the workers',
          },
        },
        askOn({
          card: HYDRA_CARD,
          seq: 3,
        }),
        askOn({
          card: 'task',
          seq: 4,
        }),
        answerFromMessage({
          card: HYDRA_CARD,
          seq: 5,
        }),
        answerFromMessage({
          card: 'task',
          seq: 6,
        }),
      ],
    })
    const hydra = state.cards[HYDRA_CARD]!
    const task = state.cards.task!

    assert.deepEqual(
      hydra.asks?.[0]?.closed,
      {
        id: `answer:${HYDRA_CARD}`,
        at: ANSWERED_AT,
        reason: 'answered from the owner\'s message',
        evidence: OWNER_MESSAGE.id,
      },
    )
    assert.equal(
      hydra.asks?.[0]?.answered,
      `answer:${HYDRA_CARD}`,
    )
    assert.deepEqual(
      recordedAnswers({ card: hydra }),
      [],
    )
    assert.equal(
      task.asks?.[0]?.closed,
      undefined,
    )
    assert.deepEqual(
      recordedAnswers({ card: task }).map(ask => ask.id),
      ['ask-task'],
    )
  },
)

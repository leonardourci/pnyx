import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emptyHydra } from '#app/reducer.ts'
import type { Ask, Card } from '#tasks/model.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { taskMention } from '#hydra/mentions.ts'
import { chatDecisions } from './chat-questions.ts'
import { leadingTask } from '#hydra/chat-messages.ts'

const at = '2026-11-01T12:00:00.000Z'
const question: Ask = {
  id: 'ask-1',
  at,
  actor: 'hydra',
  audience: 'owner',
  question: 'Which response format?',
}
const task: Card = {
  id: 'task-format',
  key: 'format',
  title: 'Choose the response format',
  column: 'needs_you',
  workspace: '',
  attention: [],
  links: [],
  tags: [],
  sourceRefs: [],
  createdSeq: 1,
  updatedSeq: 1,
  revision: 1,
  updatedAt: at,
  asks: [question],
}

test(
  'task questions stay on their cards unless the owner explicitly discusses the task or it is blocked',
  () => {
    const state = emptyHydra()
    state.cards[task.id] = structuredClone(task)
    state.keys[task.key] = task.id
    assert.deepEqual(
      chatDecisions({ state }),
      [],
    )
    assert.equal(
      chatDecisions({
        state,
        selectedTask: task.key,
      })[0]?.ask.id,
      'ask-1',
    )
    assert.equal(
      chatDecisions({
        state,
        selectedTask: task.id,
      })[0]?.ask.id,
      'ask-1',
    )
    assert.equal(
      chatDecisions({
        state,
        draft: taskMention({
          id: task.id,
          title: task.title,
        }),
      })[0]?.ask.id,
      'ask-1',
    )
    assert.deepEqual(
      chatDecisions({
        state,
        draft: 'I want to discuss the response format',
      }),
      [],
    )
    state.cards[task.id]!.status = {
      id: 'blocked',
      state: 'blocked',
      note: 'The owner must supply access',
      actor: 'worker:format',
      at,
    }
    assert.equal(
      chatDecisions({ state })[0]?.blocker,
      true,
    )
    state.cards[task.id]!.asks![0]!.deferredUntil = '2099-11-10T12:00:00.000Z'
    assert.deepEqual(
      chatDecisions({ state }),
      [],
    )
  },
)

test(
  'only the latest owner task context surfaces a task question; Hydra prose does not select one',
  () => {
    const state = emptyHydra()
    state.cards[task.id] = structuredClone(task)
    state.hydraMessages = [
      {
        id: 'owner-task',
        at,
        actor: 'web',
        action: 'send',
        task: task.id,
        text: 'Explain the choice',
        hydra: 'lab',
      },
    ]
    assert.equal(
      chatDecisions({ state })[0]?.ask.id,
      'ask-1',
    )
    state.hydraMessages.push({
      id: 'other-topic',
      at,
      actor: 'cli',
      action: 'send',
      text: 'How is everything else going?',
      hydra: 'lab',
    })
    assert.deepEqual(
      chatDecisions({ state }),
      [],
    )
    state.hydraMessages.push({
      id: 'hydra-mention',
      at,
      actor: 'hydra',
      action: 'send',
      text: taskMention({
        id: task.id,
        title: task.title,
      }),
      hydra: 'lab',
    })
    assert.deepEqual(
      chatDecisions({ state }),
      [],
    )
  },
)

test(
  'unbound Hydra questions appear in chat while answered questions remain in conversation history',
  () => {
    const state = emptyHydra()
    state.cards[HYDRA_CARD] = {
      ...structuredClone(task),
      id: HYDRA_CARD,
    }
    assert.equal(
      chatDecisions({ state })[0]?.ask.id,
      'ask-1',
    )
    state.cards[HYDRA_CARD]!.asks![0]!.deferredUntil = '2099-11-10T12:00:00.000Z'
    assert.equal(
      chatDecisions({ state })[0]?.ask.deferredUntil,
      '2099-11-10T12:00:00.000Z',
      'a deferred Hydra-wide question keeps its date controls reachable',
    )
    state.cards[HYDRA_CARD]!.asks![0]!.answered = 'owner-answer'
    assert.equal(
      leadingTask({
        entry: {
          task: HYDRA_CARD,
          text: 'Use the compact format.',
        },
      }),
      undefined,
    )
    assert.deepEqual(
      chatDecisions({ state }),
      [],
    )
  },
)

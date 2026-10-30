import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emptyHydra, replay } from './reducer.ts'
import { savedReceipt } from './save-receipts.ts'
import { readStream } from '#test-harness/streams.ts'

for (const name of [
  'reply',
  'task-message',
  'answer',
  'agent',
]) {
  test(
    `${name} confirms a saved reply when lock acquisition fails after delivery`,
    () => {
      const state = replay({
        state: emptyHydra(),
        events: readStream({ name: 'lifecycle' }),
      })
      const card = state.cards.c1!
      card.replies = [
        {
          id: 'attempt',
          state: 'delivered',
        },
      ]
      const args = name === 'answer' || name === 'agent'
        ? [
          card.id,
          'setting',
          'value',
          'attempt',
          'request',
        ]
        : [
          card.id,
          'hello',
          'attempt',
        ]
      const command = {
        type: 'command' as const,
        id: 'command',
        name,
        args,
      }
      assert.deepEqual(
        savedReceipt({
          command,
          state,
        }),
        {
          type: 'receipt',
          id: 'command',
          saved: true,
          reply: {
            card: card.id,
            reply: 'attempt',
            state: 'delivered',
          },
        },
      )
      card.replies = [
        {
          id: 'attempt',
          state: 'failed',
        },
      ]
      assert.equal(
        savedReceipt({
          command,
          state,
        }),
        undefined,
      )
      card.replies = []
      assert.equal(
        savedReceipt({
          command,
          state,
        }),
        undefined,
      )
    },
  )
}

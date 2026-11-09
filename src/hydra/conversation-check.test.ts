import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkConversation } from './conversation-check.ts'
import type { ThreadEntry } from './transcripts-read.ts'

test(
  'the conversation contract detects missing, duplicate, reordered and changed records',
  () => {
    const owner: ThreadEntry = {
      id: 'owner',
      kind: 'message',
      role: 'user',
      text: 'Again',
    }
    const repeated: ThreadEntry = {
      ...owner,
      id: 'owner-again',
    }
    const reply: ThreadEntry = {
      id: 'reply',
      kind: 'message',
      role: 'assistant',
      text: 'Ready',
      final: true,
    }
    const tool: ThreadEntry = {
      id: 'tool',
      kind: 'tool',
      role: 'Read',
      text: 'release.txt',
    }
    const note: ThreadEntry = {
      id: 'note',
      kind: 'message',
      role: 'assistant',
      text: 'Checking',
      final: false,
    }
    const missing: ThreadEntry = {
      ...reply,
      id: 'missing',
    }
    assert.deepEqual(
      checkConversation({
        expected: [
          owner,
          repeated,
          note,
          tool,
          reply,
        ],
        conversation: {
          through: 0,
          entries: [
            owner,
            repeated,
            reply,
          ],
          folds: {
            reply: {
              tasks: [],
              notes: [
                note,
                tool,
              ],
            },
          },
          timings: {},
        },
      }),
      [],
    )
    assert.deepEqual(
      checkConversation({
        expected: [
          owner,
          repeated,
          missing,
          note,
          tool,
          reply,
        ],
        conversation: {
          through: 0,
          entries: [
            reply,
            owner,
            repeated,
            repeated,
          ],
          folds: {},
          timings: {},
        },
      }),
      [
        {
          kind: 'duplicate',
          reference: 'owner-again',
        },
        {
          kind: 'missing',
          reference: 'missing',
        },
        {
          kind: 'progress',
          reference: 'note',
        },
        {
          kind: 'tool',
          reference: 'tool',
        },
        {
          kind: 'order',
          reference: 'reply',
        },
      ],
    )
    assert.deepEqual(
      checkConversation({
        expected: [reply],
        conversation: {
          through: 0,
          entries: [
            {
              ...reply,
              text: 'Partial',
            },
          ],
          folds: {},
          timings: {},
        },
      }),
      [
        {
          kind: 'text',
          reference: 'reply',
        },
      ],
    )
    assert.deepEqual(
      checkConversation({
        expected: [
          owner,
          reply,
        ],
        ordered: [reply],
        conversation: {
          through: 0,
          entries: [
            reply,
            owner,
          ],
          folds: {},
          timings: {},
        },
      }),
      [],
    )
    assert.deepEqual(
      checkConversation({
        expected: [],
        conversation: {
          through: 0,
          entries: [
            {
              ...owner,
              id: 'injected',
              hidden: true,
            },
          ],
          folds: {},
          timings: {},
        },
      }),
      [
        {
          kind: 'hidden',
          reference: 'injected',
        },
        {
          kind: 'unexpected',
          reference: 'injected',
        },
      ],
    )
  },
)

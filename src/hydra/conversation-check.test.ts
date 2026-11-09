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
          trailing: {},
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
          trailing: {},
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
          trailing: {},
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
          trailing: {},
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
          trailing: {},
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
    const reminder: ThreadEntry = {
      id: 'reminder',
      kind: 'message',
      role: 'Pnyx',
      text: 'Review the release receipt.',
    }
    assert.deepEqual(
      checkConversation({
        expected: [reminder],
        conversation: {
          through: 0,
          entries: [],
          folds: {},
          timings: {},
          trailing: {},
        },
      }),
      [
        {
          kind: 'missing',
          reference: 'reminder',
        },
      ],
    )
    assert.deepEqual(
      checkConversation({
        expected: [],
        conversation: {
          through: 0,
          entries: [reminder],
          folds: {},
          timings: {},
          trailing: {},
        },
      }),
      [
        {
          kind: 'unexpected',
          reference: 'reminder',
        },
      ],
    )
  },
)

test(
  'progress trailing a turn without a reply counts as present',
  () => {
    const owner: ThreadEntry = {
      id: 'owner',
      kind: 'message',
      role: 'user',
      text: 'Check the build',
    }
    const tool: ThreadEntry = {
      id: 'tool',
      kind: 'tool',
      role: 'Bash',
      text: '{"command":"pnpm build"}',
    }

    assert.deepEqual(
      checkConversation({
        expected: [
          owner,
          tool,
        ],
        conversation: {
          through: 0,
          entries: [owner],
          folds: {},
          timings: {},
          trailing: { owner: [tool] },
        },
      }),
      [],
    )
  },
)

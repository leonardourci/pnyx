import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkConversation, ownerSendOrder } from './conversation-check.ts'
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

test(
  'the conversation contract holds owner messages to the order they were sent, even one the agent read late',
  () => {
    const owner = ({
      id,
      at,
    }: {
      id: string
      at: string
    }): ThreadEntry => ({
      id,
      reference: id,
      kind: 'message',
      role: 'user',
      text: id,
      at,
    })
    const comments = owner({
      id: 'comments',
      at: '2026-11-11T15:54:58.074Z',
    })
    // Taken mid-turn, so it kept its earlier send time.
    const inscribe = owner({
      id: 'inscribe',
      at: '2026-11-11T15:54:55.249Z',
    })
    const messages = [
      comments,
      inscribe,
    ].map(entry => ({
      id: entry.id,
      action: 'send' as const,
      actor: 'web',
      hydra: 'hydra',
      text: entry.text,
      at: '2026-11-11T15:54:00.000Z',
    }))
    const {
      late,
      sent,
    } = ownerSendOrder({
      messages,
      expected: [
        inscribe,
        comments,
      ],
    })
    const check = ({ shown }: { shown: ThreadEntry[] }) => checkConversation({
      expected: shown,
      conversation: {
        through: 0,
        entries: shown,
        folds: {},
        timings: {},
        trailing: {},
      },
      ordered: [
        inscribe,
        comments,
      ].filter(entry => !late.has(entry)),
      sent,
    })
    assert.deepEqual(
      check({
        shown: [
          comments,
          inscribe,
        ],
      }),
      [],
    )
    assert.deepEqual(
      check({
        shown: [
          inscribe,
          comments,
        ],
      }),
      [
        {
          kind: 'order',
          reference: 'inscribe',
        },
      ],
    )
  },
)

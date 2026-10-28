import { mergeThreadPages } from './conversation-history.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { HydraEvent } from '#app/model.ts'
import { recordEntries, type ThreadEntry } from '#hydra/transcripts-read.ts'
import { hydraConversation } from './conversation.ts'

const at = ({ minute }: { minute: number }) => `2026-10-22T10:${String(minute).padStart(
  2,
  '0',
)}:00.000Z`
const entry = ({
  id,
  minute,
  role = 'assistant',
  text = id,
}: {
  id: string
  minute: number
  role?: string
  text?: string
}): ThreadEntry => ({
  id,
  kind: 'message',
  role,
  text,
  at: at({ minute }),
})
const action = ({
  minute,
  task,
  actor = 'hydra',
}: {
  minute: number
  task: string
  actor?: string
}): HydraEvent => ({
  v: 1,
  seq: minute,
  id: `action-${minute}`,
  at: at({ minute }),
  actor,
  cardId: task,
  type: 'task.brief',
  data: {
    before: '',
    after: 'A changed brief',
  },
  reason: 'Keep scope current',
  details: 'The owner clarified the boundaries.',
})

test(
  'an owner turn that ends with NO_REPLY still shows the reply written before it',
  () => {
    const conversation = ({
      quiet,
      working,
    }: {
      quiet: string
      working: boolean
    }) => hydraConversation({
      messages: [],
      transcript: [
        entry({
          id: 'owner',
          minute: 0,
          role: 'user',
        }),
        entry({
          id: 'reply',
          minute: 1,
          text: 'Agreed, I sent it to the worker.',
        }),
        entry({
          id: 'quiet',
          minute: 3,
          text: quiet,
        }),
      ],
      actions: [
        action({
          minute: 2,
          task: 't1',
        }),
      ],
      columns: [],
      working,
      thinking: false,
    })
    const result = conversation({
      quiet: 'NO_REPLY',
      working: false,
    })
    assert.deepEqual(
      result.entries.map(entry => entry.id),
      [
        'owner',
        'reply',
      ],
    )
    assert.deepEqual(
      result.folds.get('reply')?.notes,
      [],
    )
    assert.equal(
      result.folds.get('reply')?.tasks.length,
      1,
    )
    assert.deepEqual(
      conversation({
        quiet: 'NO_RE',
        working: true,
      }).entries.map(entry => entry.id),
      [
        'owner',
        'reply',
      ],
    )
  },
)

test(
  'an internal wake remains an invisible boundary even when its words are stripped',
  () => {
    const wake = recordEntries({
      record: {
        type: 'user',
        timestamp: at({ minute: 3 }),
        message: {
          content: [
            {
              type: 'text',
              text: '<pnyx-wake>Run hydra check</pnyx-wake>',
            },
          ],
        },
      },
      offset: 100,
      boundaries: true,
    })
    assert.equal(
      wake[0]?.hidden,
      true,
    )
    assert.equal(
      wake[0]?.text,
      '',
    )
    const result = hydraConversation({
      messages: [],
      transcript: [
        entry({
          id: 'owner',
          minute: 0,
          role: 'user',
        }),
        entry({
          id: 'reply',
          minute: 1,
        }),
        ...wake,
        entry({
          id: 'reading',
          minute: 4,
        }),
      ],
      actions: [
        action({
          minute: 5,
          task: 't1',
        }),
      ],
      columns: [],
      working: true,
      thinking: true,
    })
    assert.deepEqual(
      result.entries.map(entry => entry.id),
      [
        'owner',
        'reply',
      ],
    )
    assert.equal(
      result.folds.size,
      0,
    )
  },
)

test(
  'live internal turns hide their text before the transcript has recorded the input',
  () => {
    const transcript = [
      entry({
        id: 'owner',
        minute: 0,
        role: 'user',
      }),
      entry({
        id: 'reply',
        minute: 1,
      }),
      entry({
        id: 'live-report-progress',
        minute: 3,
      }),
    ]
    const result = hydraConversation({
      messages: [],
      transcript,
      columns: [],
      currentTurn: {
        at: at({ minute: 3 }),
        owner: false,
      },
      working: true,
      thinking: false,
      actions: [
        action({
          minute: 4,
          task: 't1',
        }),
      ],
    })
    assert.deepEqual(
      result.entries.map(entry => entry.id),
      [
        'owner',
        'reply',
      ],
    )
    assert.equal(
      result.folds.size,
      0,
    )
    assert.equal(
      result.timings.get('reply')?.reply,
      'reply',
    )
  },
)

test(
  'loaded native history survives advancing and reconnected live pages without stale live copies',
  () => {
    const entries = Array.from(
      { length: 140 },
      (
        _,
        index,
      ) => ({
        id: `saved:${index}`,
        kind: 'message' as const,
        role: 'assistant',
        text: `Reply ${index}`,
        at: new Date(Date.UTC(
          2026,
          9,
          22,
          10,
          0,
          index,
        )).toISOString(),
      }),
    )
    const page = ({ items }: { items: ThreadEntry[] }): import('#hydra/transcripts-read.ts').ThreadPage => ({
      card: '$hydra',
      session: 'fixture:one',
      entries: items,
      route: true,
      watching: 'unknown',
    })
    const latest = mergeThreadPages({
      before: page({
        items: entries.slice(
          0,
          60,
        ),
      }),
      latest: page({
        items: entries.slice(
          60,
          120,
        ),
      }),
    })
    const advancing = mergeThreadPages({
      before: latest,
      latest: page({
        items: [
          ...entries.slice(80),
          {
            id: 'live:reply',
            kind: 'message',
            role: 'assistant',
            text: 'Partial reply',
          },
        ],
      }),
    })
    const reconnected = mergeThreadPages({
      before: advancing,
      latest: page({ items: entries.slice(80) }),
    })
    assert.deepEqual(
      reconnected.entries,
      entries,
    )
    assert.equal(
      reconnected.older,
      undefined,
    )
    const newSession = {
      ...page({ items: entries.slice(-1) }),
      session: 'fixture:two',
    }
    assert.deepEqual(
      mergeThreadPages({
        before: reconnected,
        latest: newSession,
      }).entries,
      entries.slice(-1),
    )
  },
)

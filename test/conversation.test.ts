import { loadEarlierMessages, mergeThreadPages } from '../web/src/hydra/conversation-history.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { HydraMessage } from '../src/core/model.ts'
import type { HydraEvent } from '../src/app/model.ts'
import { recordEntries, type ThreadEntry } from '../src/thread/read.ts'
import { hydraConversation } from '../web/src/hydra/conversation.ts'

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
  'owner replies keep one last text and group their recorded changes by task',
  () => {
    const transcript = [
      entry({
        id: 'owner',
        minute: 0,
        role: 'user',
      }),
      entry({
        id: 'progress',
        minute: 1,
      }),
      {
        ...entry({
          id: 'tool',
          minute: 2,
        }),
        kind: 'tool' as const,
      },
      entry({
        id: 'reply',
        minute: 5,
      }),
      entry({
        id: 'wake',
        minute: 6,
        role: 'user',
        text: 'worker report',
      }),
      entry({
        id: 'internal-progress',
        minute: 7,
      }),
      entry({
        id: 'quiet',
        minute: 9,
        text: 'NO_REPLY',
      }),
      entry({
        id: 'wake-again',
        minute: 10,
        role: 'user',
        text: 'worker outcome',
      }),
      entry({
        id: 'outcome-progress',
        minute: 11,
      }),
      entry({
        id: 'outcome',
        minute: 12,
      }),
    ]
    const report = ({
      id,
      text,
      minute,
    }: {
      id: string
      text: string
      minute: number
    }): HydraMessage => ({
      id,
      text,
      at: at({ minute }),
      actor: 'worker:t1',
      action: 'send',
      hydra: 'default',
      task: 't1',
    })
    const result = hydraConversation({
      messages: [
        report({
          id: 'r1',
          text: 'worker report',
          minute: 6,
        }),
        report({
          id: 'r2',
          text: 'worker outcome',
          minute: 10,
        }),
      ],
      transcript,
      actions: [
        action({
          minute: 4,
          task: 't1',
        }),
        action({
          minute: 3,
          task: 't2',
        }),
        action({
          minute: 2,
          task: 't1',
        }),
        action({
          minute: 8,
          task: 't3',
        }),
      ],
      columns: [],
      working: false,
      thinking: false,
    })
    assert.deepEqual(
      result.entries.map(entry => entry.id),
      [
        'owner',
        'reply',
        'outcome',
      ],
    )
    assert.deepEqual(
      result.folds.get('reply')?.tasks[0]?.updates.map(update => update.id),
      [
        'action-2',
        'action-4',
      ],
    )
    assert.equal(
      result.folds.get('reply')?.tasks[0]?.updates[0]?.note,
      'Keep scope current\n\nThe owner clarified the boundaries.',
    )
    assert.deepEqual(
      [...result.folds.keys()],
      ['reply'],
    )
    assert.deepEqual(
      result.folds.get('reply')?.tasks.map(task => [
        task.task,
        task.updates.length,
      ]),
      [
        [
          't1',
          2,
        ],
        [
          't2',
          1,
        ],
      ],
    )
    assert.deepEqual(
      result.folds.get('reply')?.notes.map(note => note.id),
      ['progress'],
    )
  },
)

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
  'a decision jump loads earlier pages until its question, keeping entries and action events',
  async () => {
    const cursors: string[] = []
    const result = await loadEarlierMessages({
      past: null,
      cursor: 'page-3',
      until: at({ minute: 1 }),
      load: async ({ before }) => {
        cursors.push(before)
        const minutes = new Map([
          [
            'page-3',
            5,
          ],
          [
            'page-2',
            3,
          ],
          [
            'page-1',
            0,
          ],
        ])
        const nextPages = new Map([
          [
            'page-3',
            'page-2',
          ],
          [
            'page-2',
            'page-1',
          ],
        ])
        const minute = minutes.get(before)
        assert.ok(minute !== undefined)
        const older = nextPages.get(before)

        return {
          card: '$hydra',
          entries: [
            entry({
              id: before,
              minute,
              role: 'user',
            }),
          ],
          actions: [
            action({
              minute,
              task: 't1',
            }),
          ],
          older,
          route: true,
          watching: 'unknown',
        }
      },
    })
    assert.deepEqual(
      cursors,
      [
        'page-3',
        'page-2',
        'page-1',
      ],
    )
    assert.deepEqual(
      result?.entries.map(entry => entry.id),
      [
        'page-1',
        'page-2',
        'page-3',
      ],
    )
    assert.equal(
      result?.actions?.length,
      3,
    )
    assert.equal(
      result?.older,
      undefined,
    )
    await assert.rejects(
      loadEarlierMessages({
        past: null,
        cursor: 'stuck',
        until: at({ minute: 0 }),
        load: async () => ({
          card: '$hydra',
          entries: [],
          older: 'stuck',
          route: true,
          watching: 'unknown',
        }),
      }),
      /did not advance/,
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
    const page = ({ items }: { items: ThreadEntry[] }): import('../src/thread/read.ts').ThreadPage => ({
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

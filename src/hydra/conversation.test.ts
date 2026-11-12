import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { HydraEvent } from '#app/model.ts'
import { hydraConversation } from './conversation.ts'
import { mergeThreadPages } from './thread-history.ts'
import { recordEntries, type ThreadEntry, type ThreadPage } from './transcripts-read.ts'

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
  'internal commentary survives a quiet ending and keeps every progress record',
  () => {
    const result = hydraConversation({
      messages: [],
      transcript: [
        {
          ...entry({
            id: 'wake',
            minute: 0,
            role: 'user',
            text: '',
          }),
          hidden: true,
        },
        {
          ...entry({
            id: 'first',
            minute: 1,
          }),
          final: false,
        },
        {
          ...entry({
            id: 'second',
            minute: 2,
          }),
          final: false,
        },
        {
          ...entry({
            id: 'quiet',
            minute: 3,
            text: 'NO_REPLY',
          }),
          final: true,
        },
      ],
      actions: [],
      columns: [],
      working: false,
      tools: true,
      thinking: false,
    })
    assert.deepEqual(
      result.entries.map(item => item.id),
      ['second'],
    )
    assert.deepEqual(
      result.folds.get('second')?.notes.map(item => item.id),
      ['first'],
    )
  },
)

test(
  'progress and tools retain their order between multiple completed replies',
  () => {
    const result = hydraConversation({
      messages: [],
      transcript: [
        entry({
          id: 'owner',
          minute: 0,
          role: 'user',
        }),
        {
          ...entry({
            id: 'first-note',
            minute: 1,
          }),
          final: false,
        },
        {
          ...entry({
            id: 'first-tool',
            minute: 2,
            role: 'Read',
          }),
          kind: 'tool',
        },
        {
          ...entry({
            id: 'first-reply',
            minute: 3,
          }),
          final: true,
        },
        {
          ...entry({
            id: 'second-note',
            minute: 4,
          }),
          final: false,
        },
        {
          ...entry({
            id: 'second-reply',
            minute: 5,
          }),
          final: true,
        },
        {
          ...entry({
            id: 'last-tool',
            minute: 6,
            role: 'Read',
          }),
          kind: 'tool',
        },
      ],
      actions: [],
      columns: [],
      working: false,
      tools: true,
      thinking: false,
    })
    assert.deepEqual(
      result.entries.map(item => item.id),
      [
        'owner',
        'first-reply',
        'second-reply',
      ],
    )
    assert.deepEqual(
      result.folds.get('first-reply')?.notes.map(item => item.id),
      [
        'first-note',
        'first-tool',
      ],
    )
    assert.deepEqual(
      result.folds.get('second-reply')?.notes.map(item => item.id),
      ['second-note'],
    )
    assert.deepEqual(
      result.trailing.get('second-reply')?.map(item => item.id),
      ['last-tool'],
    )
  },
)

test(
  'owner progress stays visible when a streamed message reaches the native transcript',
  () => {
    const owner = entry({
      id: 'owner',
      minute: 0,
      role: 'user',
    })
    const earlier: ThreadEntry = {
      ...entry({
        id: 'earlier',
        minute: 1,
        text: 'Preparing the count',
      }),
      final: false,
    }
    const completed: ThreadEntry = {
      ...entry({
        id: 'completed',
        minute: 2,
        text: 'Counted the first batch',
      }),
      final: true,
    }
    const live: ThreadEntry = {
      ...entry({
        id: 'live:progress',
        minute: 3,
        text: 'Checking the pebbles',
      }),
      streaming: true,
    }
    const saved = recordEntries({
      record: {
        type: 'assistant',
        timestamp: at({ minute: 3 }),
        message: {
          stop_reason: 'tool_use',
          content: 'Checking the pebbles',
        },
      },
      offset: 100,
    })
    const conversation = ({
      transcript,
      working = true,
    }: {
      transcript: ThreadEntry[]
      working?: boolean
    }) => hydraConversation({
      messages: [],
      transcript: [
        owner,
        earlier,
        completed,
        ...transcript,
      ],
      actions: [],
      columns: [],
      working,
      tools: true,
      thinking: false,
    })
    assert.deepEqual(
      conversation({ transcript: [live] }).entries.map(entry => entry.text),
      [
        'owner',
        'Counted the first batch',
        'Checking the pebbles',
      ],
    )
    const recorded = conversation({ transcript: saved })
    assert.deepEqual(
      recorded.entries.map(entry => entry.text),
      [
        'owner',
        'Counted the first batch',
        'Checking the pebbles',
      ],
    )
    assert.deepEqual(
      recorded.folds.get('completed')?.notes.map(entry => entry.text),
      ['Preparing the count'],
    )
    const finished = conversation({
      transcript: [
        ...saved,
        {
          ...entry({
            id: 'answer',
            minute: 4,
            text: 'Counted the pebbles',
          }),
          final: true,
        },
      ],
      working: false,
    })
    assert.deepEqual(
      finished.entries.map(entry => entry.text),
      [
        'owner',
        'Counted the first batch',
        'Counted the pebbles',
      ],
    )
    assert.deepEqual(
      finished.folds.get('answer')?.notes.map(entry => entry.text),
      ['Checking the pebbles'],
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
        {
          ...entry({
            id: 'quiet',
            minute: 3,
            text: quiet,
          }),
          streaming: working,
        },
      ],
      actions: [
        action({
          minute: 2,
          task: 't1',
        }),
      ],
      columns: [],
      working,
      tools: true,
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
  'an internal wake hides its input while preserving assistant commentary',
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
      tools: true,
      thinking: true,
    })
    assert.deepEqual(
      result.entries.map(entry => entry.id),
      [
        'owner',
        'reply',
        'reading',
      ],
    )
    assert.equal(
      result.folds.size,
      0,
    )
  },
)

test(
  'live internal commentary remains visible before the transcript records its input',
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
      tools: true,
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
        'live-report-progress',
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
    const page = ({ items }: { items: ThreadEntry[] }): ThreadPage => ({
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

test(
  'mixed native blocks keep thinking and tool progress before the text that follows them',
  () => {
    const entries = recordEntries({
      offset: 0,
      record: {
        type: 'assistant',
        timestamp: at({ minute: 1 }),
        message: {
          stop_reason: 'end_turn',
          content: [
            {
              type: 'thinking',
              thinking: 'Reason before answering',
            },
            {
              type: 'text',
              text: 'First response',
            },
            {
              type: 'tool_use',
              id: 'inspect',
              name: 'Read',
              input: { file_path: 'release.txt' },
            },
            {
              type: 'text',
              text: 'Final response',
            },
          ],
        },
      },
    })
    const conversation = hydraConversation({
      messages: [],
      columns: [],
      working: false,
      transcript: [
        entry({
          id: 'owner',
          minute: 0,
          role: 'You',
        }),
        ...entries,
      ],
      actions: [],
      tools: true,
      thinking: true,
    })
    const rendered = conversation.entries.flatMap(item => [
      ...(conversation.folds.get(item.id)?.notes ?? []),
      item,
    ])
    assert.deepEqual(
      rendered.map(item => item.text),
      [
        'owner',
        'Reason before answering',
        'First response',
        '{"file_path":"release.txt"}',
        'Final response',
      ],
    )
    assert.deepEqual(
      entries.map(item => item.id),
      [
        '0:t0',
        '0:m0',
        '0:t2',
        '0:m1',
      ],
    )
  },
)

test(
  'quiet reply prefixes hide only while streaming',
  () => {
    const result = hydraConversation({
      messages: [],
      actions: [],
      columns: [],
      working: false,
      tools: true,
      thinking: false,
      transcript: [
        {
          id: 'partial',
          kind: 'message',
          role: 'assistant',
          text: 'NO',
          streaming: true,
        },
        {
          id: 'no',
          kind: 'message',
          role: 'assistant',
          text: 'NO',
          final: true,
        },
        {
          id: 'n',
          kind: 'message',
          role: 'assistant',
          text: 'N',
          final: true,
        },
        {
          id: 'quiet',
          kind: 'message',
          role: 'assistant',
          text: 'NO_REPLY',
          final: true,
        },
        {
          id: 'explain',
          kind: 'message',
          role: 'assistant',
          text: 'NO_REPLY is a marker',
          final: true,
        },
      ],
    })
    assert.deepEqual(
      result.entries.map(entry => entry.text),
      [
        'NO',
        'N',
        'NO_REPLY is a marker',
      ],
    )
  },
)

const liveTurn: ThreadEntry[] = [
  entry({
    id: 'owner',
    minute: 0,
    role: 'user',
  }),
  {
    ...entry({
      id: 'plan',
      minute: 1,
      text: 'Checking the release',
    }),
    final: false,
    streaming: true,
  },
  {
    ...entry({
      id: 'thought',
      minute: 2,
      role: 'assistant',
    }),
    kind: 'thinking',
  },
  {
    ...entry({
      id: 'command',
      minute: 3,
      role: 'Bash',
      text: '{"command":"gh pr view 12"}',
    }),
    kind: 'tool',
  },
  {
    ...entry({
      id: 'output',
      minute: 4,
      role: 'tool',
      text: 'MERGED',
    }),
    kind: 'tool',
  },
]

const traceIds = ({ result }: { result: ReturnType<typeof hydraConversation> }) => [
  ...result.entries,
  ...[...result.folds.values()].flatMap(fold => fold.notes),
  ...[...result.trailing.values()].flat(),
].filter(item => item.kind !== 'message')
  .map(item => item.id)

test(
  'focus mode keeps tool calls and thinking out of a live turn, its folds and its trailing progress',
  () => {
    const result = hydraConversation({
      messages: [],
      transcript: liveTurn,
      actions: [],
      columns: [],
      working: true,
      tools: false,
      thinking: false,
    })
    assert.deepEqual(
      result.entries.map(item => item.id),
      [
        'owner',
        'plan',
      ],
    )
    assert.deepEqual(
      traceIds({ result }),
      [],
    )
  },
)

test(
  'without focus mode a live turn\'s tool calls and thinking stay inside its progress after the latest reply',
  () => {
    const result = hydraConversation({
      messages: [],
      transcript: liveTurn,
      actions: [],
      columns: [],
      working: true,
      tools: true,
      thinking: true,
    })
    assert.deepEqual(
      result.entries.map(item => item.id),
      [
        'owner',
        'plan',
      ],
    )
    assert.deepEqual(
      result.trailing.get('plan')?.map(item => item.id),
      [
        'thought',
        'command',
        'output',
      ],
    )
  },
)

test(
  'a turn with no reply yet keeps its progress after the owner\'s message',
  () => {
    const result = hydraConversation({
      messages: [],
      transcript: liveTurn.filter(item => item.id !== 'plan'),
      actions: [],
      columns: [],
      working: true,
      tools: true,
      thinking: false,
    })
    assert.deepEqual(
      result.entries.map(item => item.id),
      ['owner'],
    )
    assert.deepEqual(
      result.trailing.get('owner')?.map(item => item.id),
      [
        'command',
        'output',
      ],
    )
  },
)

test(
  'progress before a Pnyx notice folds above the notice instead of showing as chat rows',
  () => {
    const result = hydraConversation({
      messages: [],
      transcript: [
        entry({
          id: 'owner',
          minute: 0,
          role: 'user',
        }),
        {
          ...entry({
            id: 'command',
            minute: 1,
            role: 'Bash',
            text: '{"command":"git status"}',
          }),
          kind: 'tool',
        },
        entry({
          id: 'notice',
          minute: 2,
          role: 'Pnyx',
          text: 'Hydra restarted',
        }),
      ],
      actions: [],
      columns: [],
      working: false,
      tools: true,
      thinking: false,
    })
    assert.deepEqual(
      result.entries.map(item => item.id),
      [
        'owner',
        'notice',
      ],
    )
    assert.deepEqual(
      result.folds.get('notice')?.notes.map(item => item.id),
      ['command'],
    )
  },
)

test(
  'an owner message the agent took mid-turn shows after the owner message sent before it',
  () => {
    const sent = ({
      id,
      minute,
    }: {
      id: string
      minute: number
    }) => ({
      id,
      actor: 'web',
      text: id,
      at: at({ minute }),
      action: 'send' as const,
      hydra: 'hydra',
    })
    const result = hydraConversation({
      messages: [
        sent({
          id: 'comments',
          minute: 1,
        }),
        sent({
          id: '/inscribe',
          minute: 2,
        }),
      ],
      // Claude Code records the second, which joins the first one's turn, as an attachment rather than a user message.
      transcript: [
        {
          ...entry({
            id: 'native-comments',
            minute: 3,
            role: 'user',
            text: 'comments',
          }),
          session: 'hydra-session',
        },
        {
          ...entry({
            id: 'reply',
            minute: 4,
          }),
          session: 'hydra-session',
          final: true,
        },
      ],
      actions: [
        action({
          minute: 2,
          task: 'task-before',
        }),
        action({
          minute: 4,
          task: 'task-during',
        }),
      ],
      columns: [],
      working: false,
      tools: false,
      thinking: false,
    })
    assert.deepEqual(
      result.entries.map(item => item.text),
      [
        'comments',
        '/inscribe',
        'reply',
      ],
    )
    assert.equal(
      result.entries[1]?.at,
      at({ minute: 2 }),
    )
    assert.equal(
      result.timings.get('reply')?.start,
      at({ minute: 3 }),
    )
    // Hydra's work before the first message was read belongs to the earlier turn, not the late message's.
    assert.deepEqual(
      [...result.folds].map(([
        id,
        fold,
      ]) => [
        id,
        fold.tasks.map(task => task.task),
      ]),
      [
        [
          'reply',
          ['task-during'],
        ],
      ],
    )
  },
)

test(
  'owner messages read later than ones sent after them keep the order they were sent in',
  () => {
    const sent = ({
      id,
      minute,
    }: {
      id: string
      minute: number
    }) => ({
      id,
      actor: 'web',
      text: id,
      at: at({ minute }),
      action: 'send' as const,
      hydra: 'hydra',
    })
    // The first message's transcript copy is at 10:05; the two sent after it were taken mid-turn and keep their send times.
    const result = hydraConversation({
      messages: [
        sent({
          id: 'first',
          minute: 1,
        }),
        sent({
          id: 'second',
          minute: 4,
        }),
        sent({
          id: 'third',
          minute: 3,
        }),
      ],
      transcript: [
        {
          ...entry({
            id: 'native-first',
            minute: 5,
            role: 'user',
            text: 'first',
          }),
          session: 'hydra-session',
        },
      ],
      actions: [],
      columns: [],
      working: false,
      tools: false,
      thinking: false,
    })
    assert.deepEqual(
      result.entries.map(item => item.text),
      [
        'first',
        'second',
        'third',
      ],
    )
  },
)

test(
  'an owner message sent at the time a late one shows at stays after it',
  () => {
    const sent = ({
      id,
      minute,
    }: {
      id: string
      minute: number
    }) => ({
      id,
      actor: 'web',
      text: id,
      at: at({ minute }),
      action: 'send' as const,
      hydra: 'hydra',
    })
    // The second shows at the first's 10:05, the third's own send time.
    const result = hydraConversation({
      messages: [
        sent({
          id: 'first',
          minute: 1,
        }),
        sent({
          id: 'second',
          minute: 4,
        }),
        sent({
          id: 'third',
          minute: 5,
        }),
      ],
      transcript: [
        {
          ...entry({
            id: 'native-first',
            minute: 5,
            role: 'user',
            text: 'first',
          }),
          session: 'hydra-session',
        },
      ],
      actions: [],
      columns: [],
      working: false,
      tools: false,
      thinking: false,
    })
    assert.deepEqual(
      result.entries.map(item => item.text),
      [
        'first',
        'second',
        'third',
      ],
    )
  },
)

test(
  'a page that starts at the place a late owner message takes keeps that message',
  () => {
    const sent = ({
      id,
      minute,
    }: {
      id: string
      minute: number
    }) => ({
      id,
      actor: 'web',
      text: id,
      at: at({ minute }),
      action: 'send' as const,
      hydra: 'hydra',
    })
    const result = hydraConversation({
      messages: [
        sent({
          id: 'first',
          minute: 1,
        }),
        sent({
          id: 'second',
          minute: 4,
        }),
      ],
      transcript: [
        {
          ...entry({
            id: 'native-first',
            minute: 5,
            role: 'user',
            text: 'first',
          }),
          session: 'hydra-session',
        },
      ],
      actions: [],
      columns: [],
      working: false,
      tools: false,
      thinking: false,
      oldest: at({ minute: 5 }),
    })
    assert.deepEqual(
      result.entries.map(item => item.text),
      [
        'first',
        'second',
      ],
    )
  },
)

test(
  'owner messages the agent read in order keep their own times between the replies',
  () => {
    const sent = ({
      id,
      minute,
    }: {
      id: string
      minute: number
    }) => ({
      id,
      actor: 'web',
      text: id,
      at: at({ minute }),
      action: 'send' as const,
      hydra: 'hydra',
    })
    const reply = ({
      id,
      minute,
    }: {
      id: string
      minute: number
    }) => ({
      ...entry({
        id,
        minute,
      }),
      session: 'hydra-session',
      final: true,
    })
    const result = hydraConversation({
      messages: [
        sent({
          id: 'first',
          minute: 1,
        }),
        sent({
          id: 'second',
          minute: 3,
        }),
      ],
      transcript: [
        reply({
          id: 'reply one',
          minute: 2,
        }),
        reply({
          id: 'reply two',
          minute: 4,
        }),
      ],
      actions: [],
      columns: [],
      working: false,
      tools: false,
      thinking: false,
    })
    assert.deepEqual(
      result.entries.map(item => item.text),
      [
        'first',
        'reply one',
        'second',
        'reply two',
      ],
    )
  },
)

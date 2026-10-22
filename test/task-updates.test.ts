import assert from 'node:assert/strict'
import { test } from 'node:test'
import { commands } from '../src/cli/commands.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadHydra } from '../src/store/hydra-store.ts'
import type { Card } from '../src/core/model.ts'
import {
  groupUpdates,
  loadRelevant,
  MAX_PAGES,
  MIN_ROWS,
  relevantUpdate,
  taskTimeline,
  type TaskEvent,
  type TaskUpdate,
} from '../web/src/hydra/task-updates.ts'

test(
  'task updates retain every declaration, deduplicate history and list relevant events newest first',
  () => {
    const previous = process.env.PNYX_HOME
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-updates-',
    ))
    process.env.PNYX_HOME = home

    try {
      commands.task([
        'create',
        '--key',
        'example',
        '--title',
        'Check the migration',
        '--column',
        'in_progress',
      ])

      for (const state of [
        'working',
        'needs_you',
        'paused',
        'blocked',
        'done',
      ]) {
        commands.task([
          'status',
          'example',
          state,
          '--note',
          `Status: ${state}`,
        ])
      }

      const state = loadHydra({ hydraId: 'default' }).state
      const card = state.cards[state.keys.example!]!
      const latest = card.statusLog!.at(-1)!
      const initial = card.statusLog![0]!
      const updates = taskTimeline({
        card,
        columns: [],
        events: [
          {
            id: latest.id,
            seq: 6,
            at: latest.at,
            type: 'task.declared',
            summary: '',
            data: { ...latest },
          },
          {
            id: initial.id,
            seq: 1,
            at: initial.at,
            type: 'task.created',
            summary: 'Created task',
          },
          {
            id: 'chat',
            seq: 7,
            at: '2030-01-01T00:00:00Z',
            type: 'chat.message',
            summary: 'Transcript',
          },
        ],
      })

      assert.equal(
        updates.length,
        6,
      )
      assert.equal(
        updates[0]!.state,
        'done',
      )
      assert.equal(
        updates.at(-1)!.id,
        initial.id,
      )
      assert.equal(
        updates.filter(update => update.id === latest.id).length,
        1,
      )
      assert.ok(updates.every(update => update.at && update.state))
    } finally {
      rmSync(
        home,
        {
          recursive: true,
          force: true,
        },
      )

      if (previous === undefined) {
        delete process.env.PNYX_HOME
      } else {
        process.env.PNYX_HOME = previous
      }
    }
  },
)

test(
  'task updates keep only relevant events and word them plainly',
  () => {
    const columns = [
      {
        id: 'custom:a' as const,
        title: 'In progress',
      },
      {
        id: 'custom:b' as const,
        title: 'Needs you',
      },
    ]
    const shown = ({
      type,
      data,
      summary = '',
    }: {
      type: string
      data: Record<string, unknown>
      summary?: string
    }) => relevantUpdate({
      columns,
      event: {
        id: type,
        seq: 1,
        at: '2026-10-21T10:00:00Z',
        type,
        summary,
        data,
      },
    })

    assert.equal(
      shown({
        type: 'card.pushed',
        data: {
          key: 'k',
          activity: 'working',
          settings: { effort: 'high' },
          before: { activity: 'idle' },
        },
      }),
      undefined,
    )
    assert.deepEqual(
      shown({
        type: 'card.pushed',
        data: {
          key: 'k',
          title: 'New name',
          before: { title: 'Old name' },
        },
      }),
      {
        kind: 'renamed',
        state: 'Renamed',
        note: 'New name',
      },
    )
    assert.deepEqual(
      shown({
        type: 'card.moved',
        data: {
          before: 'custom:a',
          after: 'custom:b',
        },
      }),
      {
        kind: 'moved',
        state: 'Moved to Needs you',
        note: '',
      },
    )
    assert.equal(
      shown({
        type: 'card.linked',
        data: {
          url: 'u',
          before: {
            kind: 'github_pr',
            url: 'u',
            number: 108,
            state: 'open',
          },
          after: {
            kind: 'github_pr',
            url: 'u',
            number: 108,
            state: 'merged',
          },
        },
      })?.state,
      'PR #108 merged',
    )

    for (const [
      type,
      data,
    ] of [
        [
          'card.outcome',
          { after: { state: 'ended' } },
        ],
        [
          'task.session',
          {
            session: 's',
            before: 'c0',
            after: 'c1',
          },
        ],
        [
          'task.project',
          {
            before: null,
            after: 'pnyx',
          },
        ],
        [
          'task.reminder',
          {
            before: null,
            after: '2030-01-01T00:00:00Z',
          },
        ],
        [
          'task.visibility',
          {
            before: false,
            after: true,
            automatic: true,
          },
        ],
        [
          'card.moved',
          {
            before: 'custom:a',
            after: 'custom:a',
          },
        ],
        [
          'card.replied',
          {
            reply: 'r1',
            state: 'delivered',
          },
        ],
        [
          'card.noted',
          {
            kind: 'summary',
            source: 'claude',
          },
        ],
        [
          'task.copy',
          {
            after: {
              state: 'active',
              path: '/tmp/copy',
            },
          },
        ],
      ] as const) {
      assert.equal(
        shown({
          type,
          data,
        }),
        undefined,
        type,
      )
    }
  },
)

test(
  'busy task history pages back until enough relevant rows show, and stops at its end',
  async () => {
    const pageSize = 5
    const event = ({
      seq,
      relevant,
    }: {
      seq: number
      relevant: boolean
    }): TaskEvent => ({
      id: `e${seq}`,
      seq,
      at: '2026-10-21T10:00:00Z',
      type: relevant ? 'task.brief' : 'card.pushed',
      summary: '',
      data: relevant ? {} : {
        key: 'k',
        activity: 'working',
      },
    })
    const history = ({
      total,
      every,
    }: {
      total: number
      every: number
    }) =>
      Array.from(
        { length: total },
        (
          _,
          i,
        ) => event({
          seq: total - i,
          relevant: i % every === 0,
        }),
      )

    const pager = ({ events }: { events: TaskEvent[] }) => {
      const calls: (number | undefined)[] = []

      const load = async ({ before }: { before?: number }) => {
        calls.push(before)

        return events.filter(e => before === undefined || e.seq < before).slice(
          0,
          pageSize,
        )
      }

      return {
        calls,
        load,
      }
    }

    const short = pager({
      events: history({
        total: 3,
        every: 10,
      }),
    })
    const ended = await loadRelevant({
      pageSize,
      load: short.load,
    })
    assert.deepEqual(
      [
        short.calls.length,
        ended.more,
      ],
      [
        1,
        false,
      ],
    )

    const sparse = pager({
      events: history({
        total: 1000,
        every: 2,
      }),
    })
    const enough = await loadRelevant({
      pageSize,
      load: sparse.load,
    })
    assert.ok(enough.found.filter(e => e.type === 'task.brief').length >= MIN_ROWS)
    assert.equal(
      enough.more,
      true,
    )
    assert.equal(
      sparse.calls.length,
      Math.ceil(MIN_ROWS * 2 / pageSize),
    )

    const noise = pager({
      events: history({
        total: 1000,
        every: 1000,
      }),
    })
    const capped = await loadRelevant({
      before: 900,
      pageSize,
      load: noise.load,
    })
    assert.equal(
      noise.calls.length,
      MAX_PAGES,
    )
    assert.equal(
      noise.calls[0],
      900,
    )
    assert.equal(
      capped.more,
      true,
    )
  },
)

test(
  'Updates pairs delivered answers with their question and keeps Hydra’s reason',
  () => {
    const event: TaskEvent = {
      id: 'decision',
      seq: 1,
      at: '2026-10-21T12:00:00Z',
      type: 'task.permission',
      actor: 'hydra',
      reason: 'The owner chose this earlier',
      summary: '',
      data: {
        id: 'q1',
        session: 's1',
        tool: 'AskUserQuestion',
        input: {},
        status: 'allow',
        questions: [
          {
            question: 'Which layout?',
            options: [{ label: 'A' }],
          },
        ],
        answers: [['A']],
      },
    }
    const shown = relevantUpdate({
      columns: [],
      event,
    })
    assert.deepEqual(
      shown?.decision,
      {
        question: 'Which layout?',
        answer: 'A',
        actor: 'Hydra',
        reason: 'The owner chose this earlier',
      },
    )
    const reply = {
      question: 'Which canary?',
      answer: 'Staging',
    }
    event.type = 'card.replied'
    event.data = {
      reply: 'r1',
      state: 'queued',
      decision: reply,
    }
    assert.equal(
      relevantUpdate({
        columns: [],
        event,
      }),
      undefined,
    )
    event.data.state = 'delivered'
    assert.deepEqual(
      relevantUpdate({
        columns: [],
        event,
      })?.decision,
      {
        ...reply,
        actor: 'Hydra',
        reason: 'The owner chose this earlier',
      },
    )
  },
)

const event = ({
  seq,
  type,
  data = {},
  actor,
  reason,
  at = `2026-10-13T13:${String(seq).padStart(
    2,
    '0',
  )}:00Z`,
}: {
  seq: number
  type: string
  data?: Record<string, unknown>
  actor?: string
  reason?: string
  at?: string
}): TaskEvent => ({
  id: `e${seq}`,
  seq,
  at,
  type,
  summary: '',
  data,
  ...(actor ? { actor } : {}),
  ...(reason ? { reason } : {}),
})

const columns = [
  {
    id: 'in_progress' as const,
    title: 'In progress',
    role: 'in_progress' as const,
  },
  {
    id: 'done' as const,
    title: 'Done',
    role: 'done' as const,
  },
]

test(
  'Updates show your asks, the Hydra’s words and its reasons, and hide what adds nothing',
  () => {
    const shown = ({
      type,
      data,
      actor,
      reason,
    }: {
      type: string
      data: Record<string, unknown>
      actor?: string
      reason?: string
    }) => relevantUpdate({
      columns,
      event: event({
        seq: 1,
        type,
        data,
        actor,
        reason,
      }),
    })

    assert.equal(
      shown({
        type: 'card.replied',
        data: {
          reply: 'r1',
          state: 'queued',
          text: 'Is quick add its own page?',
        },
        actor: 'web',
      })?.kind,
      'ask',
    )
    assert.deepEqual(
      shown({
        type: 'card.replied',
        data: {
          reply: 'r2',
          state: 'queued',
          text: 'Add one @Core alias.',
        },
        actor: 'hydra',
      }),
      {
        kind: 'told',
        state: 'Told the worker',
        note: 'Add one @Core alias.',
      },
    )
    assert.equal(
      shown({
        type: 'card.replied',
        data: {
          reply: 'r3',
          state: 'queued',
          text: 'enter',
          control: true,
        },
        actor: 'web',
      }),
      undefined,
    )
    assert.equal(
      shown({
        type: 'hydra.message',
        data: {
          action: 'send',
          text: 'Make this PR the whole restructure',
        },
        actor: 'web',
      })?.kind,
      'ask',
    )

    for (const message of [
      {
        actor: 'hydra',
        data: {
          action: 'send',
          text: 'Moved it: ready',
        },
      },
      {
        actor: 'web',
        data: {
          action: 'worker',
          text: 'Create a worker for task c1',
        },
      },
    ]) {
      assert.equal(
        shown({
          type: 'hydra.message',
          ...message,
        }),
        undefined,
      )
    }

    assert.deepEqual(
      shown({
        type: 'card.noted',
        data: {
          kind: 'context',
          source: 'hydra',
          text: 'Quick Add gets its own feature folder.',
        },
      }),
      {
        kind: 'hydra',
        state: 'Hydra replied',
        note: 'Quick Add gets its own feature folder.',
      },
    )
    assert.deepEqual(
      shown({
        type: 'card.noted',
        data: {
          kind: 'context',
          source: 'owner',
          text: 'Is it its own page?',
          at: '2026-10-13T13:11:00Z',
        },
      }),
      {
        kind: 'ask',
        state: 'You asked',
        note: 'Is it its own page?',
        at: '2026-10-13T13:11:00Z',
      },
    )
    assert.equal(
      shown({
        type: 'card.noted',
        data: {
          kind: 'summary',
          source: 'claude-code',
          text: 'Session summary',
        },
      }),
      undefined,
    )
    assert.deepEqual(
      shown({
        type: 'card.moved',
        data: {
          before: 'in_progress',
          after: 'done',
        },
        reason: 'PR #98 merged',
      }),
      {
        kind: 'done',
        state: 'Moved to Done',
        note: 'PR #98 merged',
      },
    )

    const pr = {
      kind: 'github_pr',
      url: 'https://github.com/o/r/pull/98',
      number: 98,
      state: 'open',
    }
    assert.equal(
      shown({
        type: 'card.linked',
        data: {
          url: pr.url,
          before: null,
          after: pr,
        },
      })?.state,
      'Link attached',
    )
    assert.equal(
      shown({
        type: 'card.linked',
        data: {
          url: pr.url,
          before: pr,
          after: null,
        },
      })?.state,
      'Link removed',
    )
    assert.equal(
      shown({
        type: 'card.linked',
        data: {
          url: pr.url,
          before: pr,
          after: {
            ...pr,
            checkedAt: 'later',
          },
        },
      }),
      undefined,
    )
  },
)

test(
  'the timeline drops repeated reasons, pairs Firstmate decisions, shows new intent only and closes once',
  () => {
    const card = {
      id: 'c1',
      statusLog: [],
    } as unknown as Card
    const closedAt = '2026-10-20T16:42:09Z'
    const updates = taskTimeline({
      card,
      columns,
      events: [
        event({
          seq: 1,
          type: 'card.noted',
          data: {
            kind: 'context',
            source: 'firstmate',
            text: "Captain's intent:\nInclude the whole restructure.",
          },
        }),
        event({
          seq: 2,
          type: 'task.declared',
          data: {
            state: 'paused',
            note: 'waiting for #72 to merge',
          },
        }),
        event({
          seq: 3,
          type: 'card.moved',
          data: {
            before: 'done',
            after: 'in_progress',
          },
          reason: 'paused: waiting for #72 to merge',
        }),
        event({
          seq: 4,
          type: 'card.noted',
          data: {
            kind: 'decision',
            source: 'firstmate',
            text: 'needs-decision [emulator]: Start one emulator?',
          },
        }),
        event({
          seq: 5,
          type: 'card.noted',
          data: {
            kind: 'decision',
            source: 'firstmate',
            text: 'resolved [emulator]: answered: Yes, one.',
          },
        }),
        event({
          seq: 6,
          type: 'card.noted',
          data: {
            kind: 'decision',
            source: 'firstmate',
            text: 'resolved [emulator]: firstmate approved one emulator',
          },
        }),
        event({
          seq: 7,
          type: 'card.noted',
          data: {
            kind: 'context',
            source: 'firstmate',
            text: "Captain's intent:\nInclude the whole restructure.\nAdded: fold in the PR 72 comments.",
          },
        }),
        event({
          seq: 11,
          type: 'hydra.message',
          actor: 'web',
          data: {
            action: 'send',
            text: '[@Restructure](pnyx-task:c1) Is quick add its own page?',
          },
        }),
        ...[
          {
            type: 'task.declared',
            data: {
              state: 'done',
              note: 'Closed in Firstmate',
            },
          },
          {
            type: 'card.outcome',
            data: {
              before: null,
              after: { state: 'done' },
            },
          },
          {
            type: 'card.moved',
            data: {
              before: 'in_progress',
              after: 'done',
            },
          },
        ].map((
          closing,
          index,
        ) => event({
          seq: 8 + index,
          at: closedAt,
          ...closing,
        })),
      ],
    }).toReversed()

    assert.deepEqual(
      updates.map(update => [
        update.kind,
        update.state,
        update.note,
      ]),
      [
        [
          'ask',
          'You asked',
          'Include the whole restructure.',
        ],
        [
          'status',
          'paused',
          'waiting for #72 to merge',
        ],
        [
          'moved',
          'Moved to In progress',
          '',
        ],
        [
          'decision',
          'Decision',
          '',
        ],
        [
          'ask',
          'You asked',
          'Added: fold in the PR 72 comments.',
        ],
        [
          'ask',
          'You asked',
          'Is quick add its own page?',
        ],
        [
          'done',
          'Done',
          'Closed in Firstmate',
        ],
      ],
    )
    assert.deepEqual(
      updates[3]!.decision,
      {
        questionId: 'firstmate:emulator:0',
        question: 'Start one emulator?',
        answer: 'Yes, one.',
        actor: 'Hydra',
        reason: undefined,
      },
    )
  },
)

test(
  'related updates fold only when two or more belong together',
  () => {
    const update = ({
      id,
      kind,
      at,
      state = kind,
      note = '',
    }: {
      id: string
      kind: TaskUpdate['kind']
      at: string
      state?: string
      note?: string
    }): TaskUpdate => ({
      id,
      kind,
      at,
      state,
      note,
    })
    const groups = groupUpdates({
      updates: [
        update({
          id: 'created',
          kind: 'created',
          at: '2026-10-13T12:59:56Z',
        }),
        update({
          id: 'link',
          kind: 'link',
          at: '2026-10-13T12:59:56Z',
        }),
        update({
          id: 'working',
          kind: 'status',
          at: '2026-10-13T12:59:56Z',
        }),
        update({
          id: 'ask',
          kind: 'ask',
          at: '2026-10-13T13:03:00Z',
        }),
        update({
          id: 'answer',
          kind: 'hydra',
          at: '2026-10-13T13:04:00Z',
        }),
        update({
          id: 'paused-1',
          kind: 'status',
          at: '2026-10-13T13:17:00Z',
        }),
        update({
          id: 'paused-2',
          kind: 'status',
          at: '2026-10-13T13:34:00Z',
        }),
        update({
          id: 'late-ask',
          kind: 'ask',
          at: '2026-10-14T10:00:00Z',
        }),
        update({
          id: 'late-answer',
          kind: 'hydra',
          at: '2026-10-14T10:30:00Z',
        }),
        update({
          id: 'renamed',
          kind: 'renamed',
          at: '2026-10-15T20:36:00Z',
        }),
        update({
          id: 'moved',
          kind: 'moved',
          state: 'Moved to In progress',
          at: '2026-10-15T21:43:00Z',
        }),
        ...[
          'reach',
          'platforms',
          'clean-up',
        ].map(id => update({
          id,
          kind: 'decision',
          at: '2026-10-17T14:59:21Z',
        })),
        update({
          id: 'told',
          kind: 'told',
          at: '2026-10-17T14:59:21Z',
        }),
      ],
    })

    assert.deepEqual(
      groups.map(group => [
        group.type,
        group.updates.map(item => item.id),
      ]),
      [
        [
          'moment',
          [
            'created',
            'link',
          ],
        ],
        [
          'single',
          ['working'],
        ],
        [
          'exchange',
          [
            'ask',
            'answer',
          ],
        ],
        [
          'workers',
          [
            'paused-1',
            'paused-2',
          ],
        ],
        [
          'single',
          ['late-ask'],
        ],
        [
          'single',
          ['late-answer'],
        ],
        [
          'changes',
          [
            'renamed',
            'moved',
          ],
        ],
        [
          'decisions',
          [
            'reach',
            'platforms',
            'clean-up',
          ],
        ],
        [
          'single',
          ['told'],
        ],
      ],
    )
  },
)

test(
  'a chat message that tags a task shows in that task’s history',
  async () => {
    const previous = process.env.PNYX_HOME
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-updates-',
    ))
    process.env.PNYX_HOME = home

    try {
      for (const key of [
        'tagged',
        'other',
      ]) {
        commands.task([
          'create',
          '--key',
          key,
          '--title',
          `Task ${key}`,
        ])
      }

      const state = loadHydra({ hydraId: 'default' }).state
      const tagged = state.keys.tagged!
      await commands.hydra([
        'send',
        '--text',
        `Is [@Task tagged](pnyx-task:${tagged}) its own page?`,
      ])
      const history = ({ card }: { card: string }) => commands.history([
        '--card',
        card,
        '--full',
      ]) as { events: TaskEvent[] | string }

      const messages = ({ card }: { card: string }) => {
        const events = history({ card }).events

        return Array.isArray(events) ? events.filter(item => item.type === 'hydra.message') : []
      }

      assert.equal(
        messages({ card: tagged }).length,
        1,
      )
      const taskEvents = (commands.task([
        'history',
        tagged,
        '--full',
      ]) as { events: TaskEvent[] | string }).events
      assert.equal(
        Array.isArray(taskEvents) ? taskEvents.filter(item => item.type === 'hydra.message').length : 0,
        1,
      )
      assert.equal(
        messages({ card: state.keys.other! }).length,
        0,
      )
    } finally {
      rmSync(
        home,
        {
          recursive: true,
          force: true,
        },
      )

      if (previous === undefined) {
        delete process.env.PNYX_HOME
      } else {
        process.env.PNYX_HOME = previous
      }
    }
  },
)

test(
  'default-key Firstmate decisions stay apart, a task message shows once, and a decision never hides in a moment',
  () => {
    const card = {
      id: 'c1',
      statusLog: [],
    } as unknown as Card
    const noted = ({
      seq,
      text,
    }: {
      seq: number
      text: string
    }) => event({
      seq,
      type: 'card.noted',
      data: {
        kind: 'decision',
        source: 'firstmate',
        text,
      },
    })
    const updates = taskTimeline({
      card,
      columns,
      events: [
        noted({
          seq: 1,
          text: 'needs-decision: which docs first?',
        }),
        noted({
          seq: 2,
          text: 'resolved: the API docs',
        }),
        noted({
          seq: 3,
          text: 'needs-decision: publish them now?',
        }),
        {
          ...event({
            seq: 4,
            type: 'hydra.message',
            actor: 'web',
            data: {
              action: 'send',
              task: 'c1',
              text: 'Is it its own page?',
            },
          }),
          id: 'task-context:c1:r1',
        },
        event({
          seq: 5,
          type: 'card.replied',
          actor: 'web',
          data: {
            reply: 'r1',
            state: 'queued',
            route: 'pnyx',
            text: 'Is it its own page?',
          },
        }),
      ],
    }).toReversed()

    assert.deepEqual(
      updates.map(update => update.kind === 'decision' ? [
        update.decision!.question,
        update.decision!.answer,
      ] : [
        update.kind,
        update.note,
      ]),
      [
        [
          'which docs first?',
          'the API docs',
        ],
        [
          'publish them now?',
          '',
        ],
        [
          'ask',
          'Is it its own page?',
        ],
      ],
    )

    const at = '2026-10-13T12:59:56Z'
    assert.deepEqual(
      groupUpdates({
        updates: [
          {
            id: 'link',
            kind: 'link',
            state: 'Link attached',
            note: '',
            at,
          },
          {
            id: 'decision',
            kind: 'decision',
            state: 'Decision',
            note: '',
            at,
          },
        ],
      }).map(group => group.type),
      [
        'single',
        'single',
      ],
    )
  },
)

test(
  'worker reports stay as their own Reported to Hydra rows in Updates',
  () => {
    const report: TaskEvent = {
      id: 'report',
      seq: 3,
      at: '2026-10-22T10:00:00Z',
      type: 'hydra.message',
      actor: 'worker:task-1',
      summary: '',
      data: {
        text: 'Ready for review.',
        action: 'send',
      },
    }
    const row = relevantUpdate({
      event: report,
      columns: [],
    })
    assert.deepEqual(
      row,
      {
        kind: 'report',
        state: 'Reported to Hydra',
        note: 'Ready for review.',
      },
    )
    const rows: TaskUpdate[] = [
      {
        id: 'created',
        kind: 'created',
        state: 'Created',
        note: '',
        at: report.at,
      },
      {
        id: report.id,
        at: report.at,
        ...row!,
      },
    ]
    assert.deepEqual(
      groupUpdates({ updates: rows }).map(group => group.type),
      [
        'single',
        'single',
      ],
    )
  },
)

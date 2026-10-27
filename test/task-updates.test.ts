import assert from 'node:assert/strict'
import { test } from 'node:test'
import { commands } from '../src/cli/commands.ts'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadHydra } from '../src/app/store.ts'
import type { Card, HydraEvent } from '../src/core/model.ts'
import type { Command } from '../web/src/app/connection.ts'
import { loadUpdates, noteUpdate, retryUpdates, staleUpdates, updatesOf } from '../web/src/hydra/updates-cache.ts'
import { relevantUpdate, type TaskEvent, type TaskUpdate } from '../src/core/updates.ts'
import { groupUpdates, taskTimeline, updateLayout } from '../web/src/hydra/task-updates.ts'

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
  'the Updates read filters on the server: one bounded page, no activity noise, the same timeline',
  () => {
    const previous = process.env.PNYX_HOME
    const home = mkdtempSync(join(
      tmpdir(),
      'pnyx-updates-read-',
    ))
    process.env.PNYX_HOME = home

    try {
      commands.task([
        'create',
        '--key',
        'busy',
        '--title',
        'Busy task',
      ])
      const activity = join(
        home,
        'activity.json',
      )

      for (let round = 0; round < 12; round++) {
        for (const state of [
          'working',
          'idle',
        ]) {
          writeFileSync(
            activity,
            JSON.stringify({ activity: state }),
          )
          commands.push([
            '--key',
            'busy',
            '--file',
            activity,
          ])
        }

        commands.task([
          'status',
          'busy',
          'working',
          '--note',
          `Step ${round}`,
        ])
      }

      const read = ({ args }: { args: string[] }) => commands.history([
        '--card',
        'busy',
        '--full',
        ...args,
      ]) as {
        events: TaskEvent[]
        help?: string[]
      }
      const raw = read({
        args: [
          '--limit',
          '100',
        ],
      }).events
      const filtered = read({
        args: [
          '--updates',
          '--limit',
          '50',
        ],
      }).events
      const card = Object.values(loadHydra({ hydraId: 'default' }).state.cards).find(card => card.title === 'Busy task')!

      assert.ok(raw.some(event => event.type === 'card.pushed' && !relevantUpdate({
        event,
        columns: [],
      })))
      assert.ok(filtered.length < raw.length)
      assert.ok(filtered.every(event => relevantUpdate({
        event,
        columns: [],
      })))
      assert.deepEqual(
        taskTimeline({
          card,
          events: filtered,
          columns: [],
        }),
        taskTimeline({
          card,
          events: raw,
          columns: [],
        }),
      )

      const page = read({
        args: [
          '--updates',
          '--limit',
          '5',
        ],
      })
      assert.deepEqual(
        page.events.map(event => event.id),
        filtered.slice(
          0,
          5,
        ).map(event => event.id),
      )
      assert.match(
        page.help![0]!,
        /--updates --before \d+/,
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
  'kept Updates refresh once per change they show, activity alone sends no read, and Try again reads again',
  async () => {
    const id = 'task-cache'
    const at = '2026-10-21T10:00:00Z'
    const calls: string[][] = []
    // eslint-disable-next-line pnyx/object-params -- Promise owns its resolver signature.
    const pending: ((ok: boolean) => void)[] = []

    const command: Command = async ({ args }) => {
      calls.push(args)
      const n = calls.length

      if (!await new Promise<boolean>(resolve => pending.push(resolve))) {
        throw new Error('history failed')
      }

      return {
        events: [
          {
            id: `e${n}`,
            seq: n,
            at,
            type: 'task.brief',
            summary: '',
          },
        ],
      }
    }

    const settle = async ({ ok = true }: { ok?: boolean } = {}) => {
      pending.shift()!(ok)
      await new Promise(resolve => setTimeout(
        resolve,
        0,
      ))
    }

    const event = ({
      seq,
      type,
      data,
      cardId = id,
    }: {
      seq: number
      type: string
      data: Record<string, unknown>
      cardId?: string
    }) => ({
      v: 1,
      seq,
      id: `raw${seq}`,
      at,
      actor: 'cli',
      cardId,
      type,
      data,
    }) as unknown as HydraEvent
    const load = () => loadUpdates({
      command,
      id,
    })
    const declared = ({ seq }: { seq: number }) => event({
      seq,
      type: 'task.declared',
      data: {
        state: 'working',
        note: `Step ${seq}`,
      },
    })

    void load()

    for (let seq = 1; seq <= 25; seq++) {
      noteUpdate({
        event: event({
          seq,
          type: 'card.pushed',
          data: {
            key: 'k',
            activity: seq % 2 ? 'working' : 'idle',
          },
        }),
      })
      void load()
    }

    assert.ok(calls[0]!.includes('--updates'))
    await settle()
    assert.deepEqual(
      [
        calls.length,
        updatesOf({ id }).stale,
        updatesOf({ id }).loaded,
      ],
      [
        1,
        false,
        true,
      ],
    )

    noteUpdate({ event: declared({ seq: 26 }) })
    void load()

    for (const seq of [
      27,
      28,
    ]) {
      noteUpdate({ event: declared({ seq }) })
      void load()
    }

    assert.equal(
      calls.length,
      2,
    )
    await settle()
    assert.equal(
      calls.length,
      3,
    )
    await settle()
    assert.deepEqual(
      updatesOf({ id }).events.map(event => event.id),
      [
        'e3',
        'e2',
        'e1',
      ],
    )
    await load()
    assert.equal(
      calls.length,
      3,
    )

    noteUpdate({
      event: event({
        seq: 29,
        cardId: '$board',
        type: 'hydra.message',
        data: {
          action: 'send',
          text: `[@Cache task](pnyx-task:${id}) is next`,
        },
      }),
    })
    assert.equal(
      updatesOf({ id }).stale,
      true,
    )
    void load()
    await settle({ ok: false })
    assert.equal(
      updatesOf({ id }).error,
      'history failed',
    )
    await load()
    assert.equal(
      calls.length,
      4,
    )

    void retryUpdates({
      command,
      id,
    })
    await settle()
    assert.deepEqual(
      [
        calls.length,
        updatesOf({ id }).error,
      ],
      [
        5,
        '',
      ],
    )

    staleUpdates()
    assert.equal(
      updatesOf({ id }).stale,
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

test(
  'regrouping keeps visible updates open and leaves unseen history folded',
  () => {
    const update = ({
      id,
      kind = 'status',
    }: {
      id: string
      kind?: TaskUpdate['kind']
    }): TaskUpdate => ({
      id,
      kind,
      at: '2026-10-27T00:00:00Z',
      state: 'working',
      note: id,
    })
    const one = update({ id: 'one' }), two = update({ id: 'two' }), earlier = update({ id: 'earlier' }), oldest = update({ id: 'oldest' })
    const single = updateLayout({ groups: groupUpdates({ updates: [one] }) })
    const joined = updateLayout({
      groups: groupUpdates({
        updates: [
          one,
          two,
        ],
      }),
      previous: single,
    })
    assert.equal(
      joined.open.has('one'),
      true,
    )
    const closed = {
      ...joined,
      open: new Set<string>(),
    }
    assert.equal(
      updateLayout({
        groups: groupUpdates({
          updates: [
            one,
            two,
          ],
        }),
        previous: closed,
      }),
      closed,
    )
    const split = updateLayout({
      groups: groupUpdates({
        updates: [
          one,
          update({
            id: 'separator',
            kind: 'worker',
          }),
          two,
        ],
      }),
      previous: closed,
    })
    const regrouped = updateLayout({
      groups: groupUpdates({
        updates: [
          one,
          two,
        ],
      }),
      previous: split,
    })
    assert.equal(
      regrouped.open.has('one'),
      true,
    )
    const paged = updateLayout({
      groups: groupUpdates({
        updates: [
          earlier,
          oldest,
          update({
            id: 'separator',
            kind: 'worker',
          }),
          one,
          two,
        ],
      }),
      previous: joined,
    })
    assert.deepEqual(
      [...paged.open],
      ['one'],
    )
    const firstRead = updateLayout({
      groups: groupUpdates({
        updates: [
          one,
          two,
        ],
      }),
    })
    assert.equal(
      firstRead.open.size,
      0,
    )
  },
)

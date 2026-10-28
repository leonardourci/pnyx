import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { HydraEvent } from '#app/model.ts'
import type { Card } from '#tasks/model.ts'
import type { Command } from '#web-app/connection.ts'
import { loadUpdates, noteUpdate, retryUpdates, staleUpdates, updatesOf } from './updates-cache.ts'
import { type TaskEvent, type TaskUpdate } from '#tasks/updates.ts'
import { groupUpdates, taskTimeline, updateLayout } from './task-updates.ts'

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
  'closing a task shows one Done row for its status, outcome and move',
  () => {
    const closedAt = '2026-10-20T16:42:09Z'
    const updates = taskTimeline({
      card: {
        id: 'c1',
        statusLog: [],
      } as unknown as Card,
      columns,
      events: [
        {
          type: 'task.declared',
          data: {
            state: 'done',
            note: 'Merged and released',
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
        seq: 1 + index,
        at: closedAt,
        ...closing,
      })),
    })

    assert.deepEqual(
      updates.map(update => [
        update.kind,
        update.state,
        update.note,
      ]),
      [
        [
          'done',
          'Done',
          'Merged and released',
        ],
      ],
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

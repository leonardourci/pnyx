import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as nodeModule from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import type { Zero } from '@rocicorp/zero'
import { emptyHydra, reduce } from '#app/reducer.ts'
import { decidePush } from '#tasks/push.ts'
import type { Card } from '#tasks/model.ts'
import { type TaskEvent, type TaskUpdate } from '#tasks/updates.ts'
import { groupUpdates, olderUpdates, taskTimeline, updateLayout } from './task-updates.ts'

// Node strips types from .ts but cannot read JSX, so the Updates tab's .tsx files are transpiled as they load.
// registerHooks exists from Node 22.15.
const hooks = typeof nodeModule.registerHooks === 'function'

nodeModule.registerHooks?.({
  // eslint-disable-next-line pnyx/object-params -- Node owns the load hook's signature.
  load(
    url,
    context,
    next,
  ) {
    if (!url.endsWith('.tsx')) {
      return next(
        url,
        context,
      )
    }

    return {
      format: 'module',
      shortCircuit: true,
      source: ts.transpileModule(
        readFileSync(
          fileURLToPath(url),
          'utf8',
        ),
        {
          compilerOptions: {
            jsx: ts.JsxEmit.ReactJSX,
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ESNext,
          },
        },
      ).outputText,
    }
  },
})

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

test(
  'Updates keep each lifted Hold and quote the current owner answer after Undo and another lift',
  () => {
    const created = decidePush({
      state: emptyHydra(),
      key: 'synthetic-merge-history',
      input: { title: 'Review merge' },
      meta: {
        at: '2026-10-13T13:00:00Z',
        actor: 'cli',
      },
    })
    assert.ok('event' in created)
    const state = reduce({
      state: emptyHydra(),
      event: created.event,
    })
    const card = state.cards[created.event.cardId]
    assert.ok(card)
    const updates = taskTimeline({
      card,
      columns,
      events: [
        event({
          seq: 1,
          type: 'task.asked',
          data: {
            id: 'merge-question',
            question: 'Merge PR #281?',
            audience: 'owner',
          },
        }),
        event({
          seq: 2,
          type: 'hydra.message',
          data: {
            answers: 'merge-question',
            text: 'Hold',
            choice: 'Hold',
          },
          actor: 'web',
        }),
        event({
          seq: 3,
          type: 'hydra.message',
          data: {
            answers: 'merge-question',
            text: 'Merge it this morning.',
            choice: 'Merge',
            liftsHold: 'e2',
            fromMessage: { id: 'owner-a' },
          },
          actor: 'hydra',
        }),
        event({
          seq: 4,
          type: 'task.ask.reopened',
          data: {
            ask: 'merge-question',
            answer: 'e3',
          },
        }),
        event({
          seq: 5,
          type: 'hydra.message',
          data: {
            answers: 'merge-question',
            text: 'Merge it this afternoon.',
            choice: 'Merge',
            liftsHold: 'e2',
            fromMessage: { id: 'owner-b' },
          },
          actor: 'hydra',
        }),
      ],
    })
    assert.deepEqual(
      updates.filter(update => update.state === 'Hydra lifted Hold').map(update => update.decision?.answer),
      [
        'Merge it this afternoon.',
        'Merge it this morning.',
      ],
    )
    assert.equal(
      updates.find(update => update.id === 'merge-question')?.decision?.choice,
      'Hold',
    )
    assert.equal(
      updates[0]?.decision?.question,
      'Merge PR #281?',
    )
  },
)

test(
  'Updates preserve a fresh Hold answer when Hydra asks again',
  () => {
    const created = decidePush({
      state: emptyHydra(),
      key: 'synthetic-reasked-history',
      input: { title: 'Review merge again' },
      meta: {
        at: '2026-10-13T13:00:00Z',
        actor: 'cli',
      },
    })
    assert.ok('event' in created)
    const card = reduce({
      state: emptyHydra(),
      event: created.event,
    }).cards[created.event.cardId]
    assert.ok(card)
    const updates = taskTimeline({
      card,
      columns,
      events: [
        event({
          seq: 1,
          type: 'task.asked',
          data: {
            id: 'merge-question',
            question: 'Merge PR #281?',
            audience: 'owner',
          },
        }),
        event({
          seq: 2,
          type: 'hydra.message',
          data: {
            answers: 'merge-question',
            text: 'Hold for review.',
            choice: 'Hold',
          },
          actor: 'web',
        }),
        event({
          seq: 3,
          type: 'task.ask.reopened',
          data: {
            ask: 'merge-question',
            answer: 'e2',
            reask: true,
          },
          actor: 'hydra',
        }),
        event({
          seq: 4,
          type: 'hydra.message',
          data: {
            answers: 'merge-question',
            text: 'Still Hold until I check the security change.',
            choice: 'Hold',
          },
          actor: 'web',
        }),
      ],
    })
    assert.deepEqual(
      updates.filter(update => update.decision?.answer).map(update => update.decision?.answer),
      [
        'Still Hold until I check the security change.',
        'Hold for review.',
      ],
    )
    assert.equal(
      updates[0]?.decision?.question,
      'Merge PR #281?',
    )
  },
)

// Stands in for the page's Zero client: every card.history view answers at once with the given rows or error. Each is
// a client of its own, since useQuery shares views by client.
function historyZero({
  count,
  error,
}: {
  count: number
  error?: string
}) {
  const rows = Array.from(
    { length: count },
    (
      _,
      index,
    ) => ({
      hydra_id: 'h',
      card_id: 'c1',
      seq: count - index,
      event: {
        data: {
          ...event({
            seq: count - index,
            type: 'card.renamed',
            data: { title: `Title ${count - index}` },
          }),
          cardId: 'c1',
        },
      },
    }),
  )

  return {
    clientID: crypto.randomUUID(),
    context: undefined,
    materialize: () => ({
      // eslint-disable-next-line pnyx/object-params -- Zero's view listener contract.
      addListener: (listener: (
        data: unknown,
        resultType: string,
        error?: unknown,
      ) => void) => {
        listener(
          error ? [] : rows,
          error ? 'error' : 'complete',
          error ? {
            error: 'app',
            message: error,
          } : undefined,
        )

        return () => {}
      },
      destroy() {},
      updateTTL() {},
    }),
  } as unknown as Zero
}

const renderUpdates = async ({ zero }: { zero: Zero }) => {
  const { createElement } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { ZeroProvider } = await import('@rocicorp/zero/react')
  const { TaskUpdates } = await import('./task-updates.tsx')

  return renderToStaticMarkup(createElement(
    ZeroProvider,
    {
      zero,
      children: createElement(
        TaskUpdates,
        {
          card: {
            id: 'c1',
            key: 'c1',
            title: 'Ship it',
            column: 'in_progress',
            workspace: '',
            tags: [],
            attention: [],
            links: [],
            sourceRefs: [],
            revision: 1,
            createdSeq: 1,
            updatedSeq: 1,
            updatedAt: '2026-10-13T13:00:00Z',
          } satisfies Card,
          columns,
          hydraId: 'h',
        },
      ),
    },
  ))
}

test(
  'the Updates tab offers older updates only while a page comes back full',
  { skip: !hooks },
  async () => {
    const { HISTORY_PAGE } = await import('#store/zero-schema.ts')

    assert.match(
      await renderUpdates({ zero: historyZero({ count: HISTORY_PAGE }) }),
      />Older updates</,
    )
    assert.doesNotMatch(
      await renderUpdates({ zero: historyZero({ count: 3 }) }),
      /Older updates/,
    )
  },
)

test(
  'updates Zero cannot read name the error and offer to read them again',
  { skip: !hooks },
  async () => {
    const shown = await renderUpdates({
      zero: historyZero({
        count: 0,
        error: 'query endpoint unreachable',
      }),
    })

    assert.match(
      shown,
      /query endpoint unreachable/,
    )
    assert.match(
      shown,
      />Try again</,
    )
  },
)

test(
  'Older updates stays, disabled, while the page after a full one loads, and leaves once a page comes back short',
  async () => {
    const {
      HISTORY_PAGE,
      MAX_HISTORY,
    } = await import('#store/zero-schema.ts')
    const pressed = HISTORY_PAGE * 2

    assert.equal(
      olderUpdates({
        rows: HISTORY_PAGE,
        limit: pressed,
        loading: true,
      }),
      'loading',
    )
    assert.equal(
      olderUpdates({
        rows: HISTORY_PAGE + 3,
        limit: pressed,
        loading: false,
      }),
      'hidden',
    )
    assert.equal(
      olderUpdates({
        rows: 0,
        limit: HISTORY_PAGE,
        loading: true,
      }),
      'hidden',
      'the first page loading shows no Older updates',
    )
    assert.equal(
      olderUpdates({
        rows: MAX_HISTORY,
        limit: MAX_HISTORY,
        loading: false,
      }),
      'hidden',
      'the Updates tab reads no further than its most',
    )
  },
)

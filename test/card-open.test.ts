import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Card, Column } from '../src/core/model.ts'
import { openTaskCard } from '../web/src/hydra/scroll-task.ts'
import { expandedByColumn, releaseHold, type ColumnHold } from '../web/src/hydra/view.ts'

const card = { isConnected: true } as HTMLElement

const task = ({ column }: { column: Column }): Card => ({
  id: 'task',
  key: 'task',
  title: 'Task',
  column,
  workspace: 'unassigned',
  tags: [],
  attention: [],
  links: [],
  sourceRefs: [],
  createdSeq: 1,
  updatedSeq: 1,
  revision: 1,
  updatedAt: '2026-10-22T00:00:00Z',
})

type Hooks = Partial<Parameters<typeof openTaskCard>[0]>

type Finish = ({ ready }: { ready: boolean }) => void

const later = () => {
  let finish: Finish = () => undefined

  return {
    promise: new Promise<boolean>(resolve => {
      finish = ({ ready }) => resolve(ready)
    }),
    finish: ({ ready }: { ready: boolean }) => finish({ ready }),
  }
}

const steps = () => {
  const calls: string[] = []
  const aligned = later()

  return {
    calls,
    finish: aligned.finish,
    hooks: {
      expand: () => calls.push('expand'),
      settle: async () => {
        calls.push('settle')

        return true
      },
      release: () => {
        if (!calls.includes('released')) {
          calls.push('released')
        }
      },
      opened: () => calls.push('opened'),
      align: () => {
        calls.push('align')

        return aligned.promise
      },
    },
  }
}

// Mirrors how app.tsx wires a title opening into its expansion state.
const hydra = ({ open }: { open: string[] }) => {
  const cards = Object.fromEntries([
    'prior',
    'A',
    'B',
    'C',
  ].map(id => [
    id,
    task({ column: 'custom:doing' }),
  ]))
  const state: {
    ids: string[]
    hold: ColumnHold
  } = {
    ids: open,
    hold: null,
  }
  const prune = ({ ids }: { ids: string[] }) => expandedByColumn({
    ids,
    cards,
    pending: {},
    hold: state.hold,
  })

  return {
    state,
    body: ({ id }: { id: string }) => {
      state.ids = prune({
        ids: [
          ...state.ids.filter(item => item !== id),
          id,
        ],
      })
    },
    title: ({
      id,
      controller,
      ...hooks
    }: {
      id: string
      controller: AbortController
    } & Hooks) => openTaskCard({
      find: () => card,
      expand: () => {
        state.hold = {
          id,
          owner: controller.signal,
        }
        state.ids = prune({
          ids: [
            ...state.ids.filter(item => item !== id),
            id,
          ],
        })
      },
      settle: async () => !controller.signal.aborted,
      hold: async () => !controller.signal.aborted,
      release: () => {
        const next = releaseHold({
          hold: state.hold,
          owner: controller.signal,
        })

        if (next !== state.hold) {
          state.hold = next
          state.ids = prune({ ids: state.ids })
        }
      },
      opened: () => undefined,
      align: async () => true,
      signal: controller.signal,
      ...hooks,
    }),
  }
}

const tick = () => new Promise(resolve => setImmediate(resolve))

test(
  'a title click expands at once but keeps focus and position while a rename may follow',
  async () => {
    for (const renamed of [
      false,
      true,
    ]) {
      const run = steps()
      const held = later()
      const opening = openTaskCard({
        find: () => card,
        ...run.hooks,
        hold: () => held.promise,
        signal: new AbortController().signal,
      })
      await tick()
      assert.deepEqual(
        [...run.calls],
        [
          'expand',
          'settle',
        ],
      )
      held.finish({ ready: !renamed })
      await tick()
      assert.deepEqual(
        [...run.calls],
        renamed ? [
          'expand',
          'settle',
          'released',
        ] : [
          'expand',
          'settle',
          'released',
          'settle',
          'opened',
          'align',
        ],
      )
      run.finish({ ready: true })
      assert.equal(
        await opening,
        renamed ? null : card,
      )
    }
  },
)

test(
  'a card not yet on the page expands after one layout, and an open superseded first never expands',
  async () => {
    let shown: HTMLElement | null = null
    const waiting = steps()
    const opening = openTaskCard({
      find: () => shown,
      ...waiting.hooks,
      settle: async () => {
        waiting.calls.push('settle')
        shown = card

        return true
      },
      hold: async () => true,
      signal: new AbortController().signal,
    })
    assert.deepEqual(
      [...waiting.calls],
      ['settle'],
    )
    await tick()
    assert.deepEqual(
      waiting.calls.slice(
        0,
        2,
      ),
      [
        'settle',
        'expand',
      ],
    )
    waiting.finish({ ready: true })
    await opening

    const stale = steps()
    const controller = new AbortController()
    assert.equal(
      await openTaskCard({
        find: () => null,
        ...stale.hooks,
        settle: async () => {
          controller.abort()

          return false
        },
        hold: async () => true,
        signal: controller.signal,
      }),
      null,
    )
    assert.ok(!stale.calls.includes('expand'))
  },
)

test(
  "a title opening keeps only its own column's replaced card open until its hold ends",
  async () => {
    const board = hydra({ open: ['prior'] })
    const held = later()
    const opening = board.title({
      id: 'A',
      controller: new AbortController(),
      hold: () => held.promise,
    })
    await tick()
    assert.deepEqual(
      board.state.ids,
      [
        'prior',
        'A',
      ],
    )
    assert.deepEqual(
      expandedByColumn({
        ids: [
          'prior',
          'x1',
          'A',
          'x2',
        ],
        cards: {
          x1: task({ column: 'custom:todo' }),
          x2: task({ column: 'custom:todo' }),
          prior: task({ column: 'custom:doing' }),
          A: task({ column: 'custom:doing' }),
        },
        pending: {},
        hold: board.state.hold,
      }),
      [
        'prior',
        'A',
        'x2',
      ],
    )
    held.finish({ ready: true })
    assert.equal(
      await opening,
      card,
    )
    assert.deepEqual(
      board.state,
      {
        ids: ['A'],
        hold: null,
      },
    )
  },
)

test(
  'every exit after a title opening expands ends its hold, so the next body open leaves one card',
  async () => {
    const exits: Record<string, ({ controller }: { controller: AbortController }) => Hooks> = {
      'cancelled before the rename window': ({ controller }) => ({
        settle: async () => {
          controller.abort()

          return false
        },
      }),
      'removed from the page': () => {
        let finds = 0

        return { find: () => (++finds > 2 ? null : card) }
      },
      'cancelled during the rename window': ({ controller }) => ({
        hold: async () => {
          controller.abort()

          return false
        },
      }),
      'renamed': () => ({ hold: async () => false }),
      'cancelled before alignment': ({ controller }) => {
        let settles = 0

        return {
          settle: async () => {
            if (++settles > 1) {
              controller.abort()
            }

            return !controller.signal.aborted
          },
        }
      },
      'alignment failed': () => ({ align: async () => false }),
    }

    for (const [
      exit,
      hooks,
    ] of Object.entries(exits)) {
      const board = hydra({ open: ['prior'] })
      const controller = new AbortController()
      assert.equal(
        await board.title({
          id: 'A',
          controller,
          ...hooks({ controller }),
        }),
        null,
        exit,
      )
      assert.equal(
        board.state.hold,
        null,
        exit,
      )
      board.body({ id: 'C' })
      assert.deepEqual(
        board.state.ids,
        ['C'],
        exit,
      )
    }
  },
)

test(
  "an older opening of a card never ends a newer opening's hold on it",
  async () => {
    const board = hydra({ open: ['prior'] })
    const first = new AbortController()
    const other = new AbortController()
    const again = new AbortController()
    const firstLayout = later()
    const otherHold = later()
    const againHold = later()
    const openings = [
      board.title({
        id: 'A',
        controller: first,
        settle: () => firstLayout.promise,
      }),
    ]
    first.abort()
    openings.push(board.title({
      id: 'B',
      controller: other,
      hold: () => otherHold.promise,
    }))
    await tick()
    other.abort()
    openings.push(board.title({
      id: 'A',
      controller: again,
      hold: () => againHold.promise,
    }))
    await tick()
    firstLayout.finish({ ready: false })
    otherHold.finish({ ready: false })
    await tick()
    assert.equal(
      board.state.hold?.owner,
      again.signal,
    )
    assert.deepEqual(
      board.state.ids,
      [
        'B',
        'A',
      ],
    )
    againHold.finish({ ready: true })
    assert.deepEqual(
      await Promise.all(openings),
      [
        null,
        null,
        card,
      ],
    )
    assert.deepEqual(
      board.state,
      {
        ids: ['A'],
        hold: null,
      },
    )
  },
)

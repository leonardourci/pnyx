import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Card, Column } from '../src/core/model.ts'
import { afterSteadyLayout, openTaskCard } from '../web/src/hydra/scroll-task.ts'
import { expandedByColumn } from '../web/src/hydra/view.ts'

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

test(
  'opening replaces the previous card immediately and focuses after layout without a rename delay',
  async () => {
    let ids = ['prior']
    let focused = false
    let aligned = false
    let settle: ({ ready }: { ready: boolean }) => void = () => undefined
    const layout = new Promise<boolean>(resolve => {
      settle = ({ ready }) => resolve(ready)
    })
    const opening = openTaskCard({
      find: () => card,
      expand: () => {
        ids = expandedByColumn({
          ids: [
            ...ids,
            'next',
          ],
          cards: {
            prior: task({ column: 'custom:doing' }),
            next: task({ column: 'custom:doing' }),
          },
          pending: {},
        })
      },
      settle: () => layout,
      opened: () => {
        focused = true
      },
      align: async () => {
        aligned = true

        return true
      },
      signal: new AbortController().signal,
    })
    assert.deepEqual(
      ids,
      ['next'],
    )
    assert.equal(
      focused,
      false,
    )
    settle({ ready: true })
    assert.equal(
      await opening,
      card,
    )
    assert.equal(
      focused,
      true,
    )
    assert.equal(
      aligned,
      true,
    )
  },
)

test(
  'expansion preserves the latest task in each column including pending moves',
  () => {
    assert.deepEqual(
      expandedByColumn({
        ids: [
          'prior',
          'other',
          'next',
          'moving',
        ],
        cards: {
          prior: task({ column: 'custom:doing' }),
          other: task({ column: 'custom:todo' }),
          next: task({ column: 'custom:doing' }),
        },
        pending: { moving: 'custom:done' },
      }),
      [
        'other',
        'next',
        'moving',
      ],
    )
  },
)

test(
  'an absent card waits for layout before expanding',
  async () => {
    let shown: HTMLElement | null = null
    let expanded = false
    assert.equal(
      await openTaskCard({
        find: () => shown,
        expand: () => {
          expanded = true
        },
        settle: async () => {
          shown = card

          return true
        },
        opened: () => undefined,
        align: async () => true,
        signal: new AbortController().signal,
      }),
      card,
    )
    assert.equal(
      expanded,
      true,
    )
  },
)

test(
  'cancelled, removed and unaligned openings never complete',
  async () => {
    for (const exit of [
      'before',
      'align-aborted',
      'aborted',
      'removed',
      'layout',
      'alignment',
      'detached',
    ]) {
      const controller = new AbortController()

      if (exit === 'before') {
        controller.abort()
      }

      let focused = false
      let shown: HTMLElement | null = card
      const opening = openTaskCard({
        find: () => shown,
        expand: () => undefined,
        settle: async () => {
          if (exit === 'aborted') {
            controller.abort()
          }

          if (exit === 'removed') {
            shown = null
          }

          return exit !== 'layout'
        },
        opened: () => {
          focused = true
        },
        align: async () => {
          if (exit === 'align-aborted') {
            controller.abort()
          }

          return exit !== 'alignment'
        },
        signal: controller.signal,
      })

      if (exit === 'detached') {
        shown = { isConnected: false } as HTMLElement
      }

      assert.equal(
        await opening,
        null,
        exit,
      )
      assert.equal(
        focused,
        exit === 'alignment' || exit === 'align-aborted' || exit === 'detached',
        exit,
      )
    }
  },
)

test(
  'alignment waits until the clicked card stops moving while the card it replaced shrinks',
  async () => {
    Object.assign(
      globalThis,
      {
        requestAnimationFrame: setImmediate,
        cancelAnimationFrame: clearImmediate,
      },
    )

    try {
      const tops = [
        586,
        438,
        363,
        346,
        346,
      ]
      let reads = 0
      const element = {
        getBoundingClientRect: () => ({
          top: tops[Math.min(
            reads++,
            tops.length - 1,
          )],
        }),
      } as HTMLElement
      assert.equal(
        await afterSteadyLayout({
          element,
          signal: new AbortController().signal,
        }),
        true,
      )
      assert.equal(
        reads,
        tops.length,
      )

      const controller = new AbortController()
      controller.abort()
      assert.equal(
        await afterSteadyLayout({
          element,
          signal: controller.signal,
        }),
        false,
      )
    } finally {
      Reflect.deleteProperty(
        globalThis,
        'requestAnimationFrame',
      )
      Reflect.deleteProperty(
        globalThis,
        'cancelAnimationFrame',
      )
    }
  },
)

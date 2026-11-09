import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_VIEW, DEFAULT_WIDTHS, traces, viewFor } from './view.ts'

const saved = ({ view }: { view: object }) =>
  viewFor({
    state: {
      view: {
        ...DEFAULT_VIEW,
        ...view,
      },
      config: {
        columns: [
          { id: 'queued' },
          { id: 'done' },
        ],
      },
    } as never,
  })

test(
  'saved 380/480 widths are kept, not replaced by the new defaults',
  () => {
    const view = saved({
      view: {
        hydraWidth: 480,
        defaultHydraWidth: 480,
        defaultColumnWidth: 380,
        columnWidths: { queued: 380 },
      },
    })
    assert.equal(
      view.hydraWidth,
      480,
    )
    assert.equal(
      view.defaultHydraWidth,
      480,
    )
    assert.equal(
      view.defaultColumnWidth,
      380,
    )
    assert.equal(
      view.columnWidths.queued,
      380,
    )
  },
)

test(
  'a saved view carrying the old built-in defaults picks up the new ones',
  () => {
    const view = saved({
      view: {
        defaultHydraWidth: 360,
        defaultColumnWidths: {
          queued: 290,
          done: 290,
        },
      },
    })

    assert.equal(
      view.defaultHydraWidth,
      DEFAULT_WIDTHS.hydra,
    )
    assert.equal(
      view.defaultColumnWidths.queued,
      DEFAULT_WIDTHS.column,
    )
    assert.equal(
      view.defaultColumnWidths.done,
      DEFAULT_WIDTHS.column,
    )
  },
)

test(
  'widths the owner set explicitly are kept',
  () => {
    const view = saved({
      view: {
        hydraWidth: 729,
        defaultHydraWidth: 500,
        columnWidths: { queued: 300 },
        defaultColumnWidths: { done: 420 },
      },
    })

    assert.equal(
      view.hydraWidth,
      729,
    )
    assert.equal(
      view.defaultHydraWidth,
      500,
    )
    assert.equal(
      view.columnWidths.queued,
      300,
    )
    assert.equal(
      view.defaultColumnWidths.done,
      420,
    )
  },
)

test(
  'focus mode hides tool calls and thinking unless a card shows them on its own',
  () => {
    const shown = ({ focusMode }: { focusMode: boolean }) => traces({
      view: {
        ...DEFAULT_VIEW,
        focusMode,
        cardTraceOverrides: { open: { tools: true } },
      },
      card: 'open',
    })

    assert.deepEqual(
      [
        traces({
          view: DEFAULT_VIEW,
          card: 'plain',
        }).tools,
        shown({ focusMode: true }).tools,
        shown({ focusMode: true }).thinking,
        shown({ focusMode: false }).thinking,
      ],
      [
        false,
        true,
        false,
        true,
      ],
    )
  },
)

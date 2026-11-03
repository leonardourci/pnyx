import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_VIEW, DEFAULT_WIDTHS, viewFor } from './view.ts'

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
  'new layouts use 460 px columns and 520 px chat without replacing saved 380/480 widths',
  () => {
    assert.deepEqual(
      DEFAULT_WIDTHS,
      {
        column: 460,
        hydra: 520,
      },
    )
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

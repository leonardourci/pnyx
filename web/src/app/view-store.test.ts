import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHydraView, showPage } from './view-store.ts'

const at = ({ search }: { search: string }) => Object.defineProperty(
  globalThis,
  'location',
  {
    value: { search },
    configurable: true,
  },
)

test(
  'a reopened Hydra shows the view it saved, and a link that opens a project or settings starts there',
  t => {
    t.after(() => Reflect.deleteProperty(
      globalThis,
      'location',
    ))
    at({ search: '' })
    const restored = createHydraView({
      restored: {
        expanded: [
          'task-1',
          'task-2',
        ],
        panel: false,
      },
    }).getState()
    assert.equal(
      restored.selected,
      'task-2',
    )
    assert.deepEqual(
      restored.expanded,
      [
        'task-1',
        'task-2',
      ],
    )
    assert.equal(
      restored.panel,
      false,
    )
    assert.equal(
      restored.page,
      'hydra',
    )

    at({ search: '?open-project=/p' })
    const project = createHydraView({ restored: { selected: 'task-1' } }).getState()
    assert.equal(
      project.selected,
      null,
    )
    assert.deepEqual(
      project.expanded,
      [],
    )

    at({ search: '?settings' })
    assert.equal(
      createHydraView({ restored: {} }).getState().page,
      'settings',
    )
  },
)

test(
  'showing the page already shown does not redraw the Hydra',
  t => {
    t.after(() => Reflect.deleteProperty(
      globalThis,
      'location',
    ))
    at({ search: '' })
    const view = createHydraView({ restored: {} })
    let changes = 0
    view.subscribe(() => {
      changes++
    })
    showPage({
      view,
      page: 'hydra',
    })
    assert.equal(
      changes,
      0,
    )
    showPage({
      view,
      page: 'settings',
    })
    assert.equal(
      changes,
      1,
    )
  },
)

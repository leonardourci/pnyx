import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openingView, restoreView } from './restore.ts'

test(
  'a reload restores the tab view it saved, and starts fresh from a missing or unreadable one',
  t => {
    const saved = new Map([
      [
        'view',
        '{"selected":"task-1","page":"settings","drafts":{"task-1":"Ship it"}}',
      ],
      [
        'broken',
        '{"selected":',
      ],
    ])
    Object.defineProperty(
      globalThis,
      'sessionStorage',
      {
        // eslint-disable-next-line pnyx/object-params -- Storage owns the method signature.
        value: { getItem: (key: string) => saved.get(key) ?? null },
        configurable: true,
      },
    )
    t.after(() => Reflect.deleteProperty(
      globalThis,
      'sessionStorage',
    ))

    assert.deepEqual(
      restoreView({ key: 'view' }),
      {
        selected: 'task-1',
        page: 'settings',
        drafts: { 'task-1': 'Ship it' },
      },
    )
    assert.deepEqual(
      restoreView({ key: 'missing' }),
      {},
    )
    assert.deepEqual(
      restoreView({ key: 'broken' }),
      {},
    )
  },
)

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
    const restored = openingView({
      restored: {
        expanded: [
          'task-1',
          'task-2',
        ],
        panel: false,
      },
    })
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
    const project = openingView({ restored: { selected: 'task-1' } })
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
      openingView({ restored: {} }).page,
      'settings',
    )
  },
)

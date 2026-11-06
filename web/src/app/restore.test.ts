import assert from 'node:assert/strict'
import { test } from 'node:test'
import { restoreView } from './restore.ts'

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

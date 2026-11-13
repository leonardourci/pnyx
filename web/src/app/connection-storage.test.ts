import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dropSnapshots } from './connection-storage.ts'

test(
  'the Hydra snapshots an earlier page kept in the tab are dropped, and its other saves stay',
  t => {
    const saved: Record<string, string> = {
      'pnyx:http://127.0.0.1:4319:fixture/hydra/default/:hydra-state': '{}',
      'pnyx:fixture:hydra-state': '{}',
      'pnyx:http://127.0.0.1:4319:fixture:hydra-creations': '[]',
      'restore': '{}',
    }
    // Storage lists its keys as its own properties, and removeItem is not one of them.
    Object.defineProperty(
      saved,
      'removeItem',
      {
        // eslint-disable-next-line pnyx/object-params -- Storage owns the method signature.
        value: (key: string) => Reflect.deleteProperty(
          saved,
          key,
        ),
      },
    )
    Object.defineProperty(
      globalThis,
      'sessionStorage',
      {
        value: saved,
        configurable: true,
      },
    )
    t.after(() => Reflect.deleteProperty(
      globalThis,
      'sessionStorage',
    ))

    dropSnapshots()
    assert.deepEqual(
      Object.keys(saved),
      [
        'pnyx:http://127.0.0.1:4319:fixture:hydra-creations',
        'restore',
      ],
    )
  },
)

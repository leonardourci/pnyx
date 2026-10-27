import fs from 'node:fs'
import { EventEmitter } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'

export function catalogWatches({ t }: { t: TestContext }) {
  const native = new Map<string, Set<() => void>>()
  const stats = new Map<string, Set<() => void>>()
  t.mock.method(
    fs,
    'watch',
    // eslint-disable-next-line pnyx/object-params -- Node owns fs.watch's signature.
    (
      path: string,
      changed: () => void,
    ) => {
      const listeners = native.get(String(path)) ?? new Set<() => void>()
      native.set(
        String(path),
        listeners,
      )
      listeners.add(changed)

      return Object.assign(
        new EventEmitter(),
        {
          close: () => listeners.delete(changed),
          unref() {},
        },
      )
    },
  )
  t.mock.method(
    fs,
    'watchFile',
    // eslint-disable-next-line pnyx/object-params -- Node owns fs.watchFile's signature.
    (
      path: string,
      _options: unknown,
      changed: () => void,
    ) => {
      const listeners = stats.get(String(path)) ?? new Set<() => void>()
      stats.set(
        String(path),
        listeners,
      )
      listeners.add(changed)
    },
  )
  t.mock.method(
    fs,
    'unwatchFile',
    // eslint-disable-next-line pnyx/object-params -- Node owns fs.unwatchFile's signature.
    (
      path: string,
      changed: () => void,
    ) => stats.get(String(path))?.delete(changed),
  )
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
  t.mock.timers.enable({ apis: ['setTimeout'] })

  return {
    changed({
      stat,
      path,
    }: {
      stat: boolean
      path?: string
    }) {
      const source = stat ? stats : native
      const selected = path ? [source.get(path)!] : [...source.values()]
      assert.ok(
        selected.some(listeners => listeners?.size),
        `no owned ${stat ? 'stat' : 'native'} watcher for ${path ?? 'catalog'}`,
      )

      for (const listeners of selected) {
        for (const changed of [...listeners ?? []]) {
          changed()
        }
      }

      t.mock.timers.tick(25)
    },
  }
}

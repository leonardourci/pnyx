import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import type { TestContext } from 'node:test'

export function checkRegistryLockOrder({
  t,
  hydraId,
}: {
  t: TestContext
  hydraId: string
}): void {
  const registryLock = join(
    process.env.PNYX_HOME!,
    'writer.lock',
  )
  const hydraLock = join(
    process.env.PNYX_HOME!,
    'hydras',
    hydraId,
    'writer.lock',
  )
  const originalOpen = fs.openSync
  t.mock.method(
    fs,
    'openSync',
    // eslint-disable-next-line pnyx/object-params -- Node owns fs.openSync's positional signature.
    (
      path: fs.PathLike,
      flags: fs.OpenMode,
      mode?: fs.Mode,
    ) => {
      if (String(path) === registryLock) {
        assert.equal(
          fs.existsSync(hydraLock),
          false,
          'Registry memory reads must precede the Hydra writer lock',
        )
      }

      return originalOpen(
        path,
        flags,
        mode,
      )
    },
  )
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
}

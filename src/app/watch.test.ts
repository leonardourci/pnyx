import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { watchPath } from './watch.ts'

async function until({ check }: { check(): boolean }) {
  const deadline = Date.now() + 5000

  while (!check()) {
    assert.ok(
      Date.now() < deadline,
      'watch did not observe the change',
    )
    await new Promise(resolve => setTimeout(
      resolve,
      20,
    ))
  }
}

test(
  'a late native error closes its watcher, delivers changes through polling and stops polling on close',
  async t => {
    const root = fs.mkdtempSync(join(
      tmpdir(),
      'pnyx-watch-fallback-',
    ))
    const path = join(
      root,
      'transcript',
    )
    fs.writeFileSync(
      path,
      'first',
    )
    const original = fs.watch
    let native: fs.FSWatcher | undefined
    let closes = 0
    t.mock.method(
      console,
      'error',
      () => {},
    )
    t.mock.method(
      fs,
      'watch',
      // eslint-disable-next-line pnyx/object-params -- Node owns fs.watch's signature.
      (...args: Parameters<typeof fs.watch>) => {
        native = Reflect.apply(
          original,
          fs,
          args,
        ) as fs.FSWatcher
        const close = native.close.bind(native)

        native.close = () => {
          closes++; close()
        }

        return native
      },
    )
    syncBuiltinESMExports()
    let seen = ''
    const watcher = watchPath({
      path,
      interval: 20,
      changed: () => {
        seen = fs.readFileSync(
          path,
          'utf8',
        )
      },
    })
    t.after(() => {
      watcher.close()
      t.mock.restoreAll()
      syncBuiltinESMExports()
      fs.rmSync(
        root,
        {
          recursive: true,
          force: true,
        },
      )
    })
    fs.writeFileSync(
      path,
      'second',
    )
    native!.emit(
      'error',
      Object.assign(
        new Error('descriptor limit'),
        { code: 'EMFILE' },
      ),
    )
    assert.equal(
      closes,
      1,
    )
    await until({ check: () => seen === 'second' })
    watcher.close()
    assert.equal(
      closes,
      1,
    )
  },
)

test(
  'a rejected watch callback is logged and later filesystem changes are still delivered',
  async t => {
    const root = fs.mkdtempSync(join(
      tmpdir(),
      'pnyx-watch-rejection-',
    ))
    const path = join(
      root,
      'transcript',
    )
    fs.writeFileSync(
      path,
      'first',
    )
    const errors = t.mock.method(
      console,
      'error',
      () => {},
    )
    let fail = true
    let seen = ''
    const watcher = watchPath({
      path,
      changed: async () => {
        if (fail) {
          fail = false
          throw new Error('reader failed')
        }

        seen = fs.readFileSync(
          path,
          'utf8',
        )
      },
    })
    t.after(() => {
      watcher.close(); fs.rmSync(
        root,
        {
          recursive: true,
          force: true,
        },
      )
    })
    await fs.promises.writeFile(
      path,
      'second',
    )
    await until({ check: () => errors.mock.calls.some(call => call.arguments.join(' ').includes('reader failed')) })
    fs.writeFileSync(
      path,
      'third',
    )
    await until({ check: () => seen === 'third' })
  },
)

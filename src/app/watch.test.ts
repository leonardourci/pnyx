import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pollPath, watchPath } from './watch.ts'

const SUBSCRIBERS = 11
const POLL_MS = 20

async function until({ check }: { check(): boolean }) {
  const deadline = Date.now() + 5000

  while (!check()) {
    assert.ok(
      Date.now() < deadline,
      'watch did not observe the change',
    )
    await new Promise(resolve => setTimeout(
      resolve,
      POLL_MS,
    ))
  }
}

test(
  'native failure falls back to polling, and a rejected reader does not stop later delivery',
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
    const errors = t.mock.method(
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
    let fail = true
    const watcher = watchPath({
      path,
      interval: POLL_MS,
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
    await until({ check: () => errors.mock.calls.some(call => call.arguments.join(' ').includes('reader failed')) })
    fs.writeFileSync(
      path,
      'third',
    )
    await until({ check: () => seen === 'third' })
    watcher.close()
    assert.equal(
      closes,
      1,
    )
  },
)

// fs.watchFile is mocked: the sharing is under test, not how soon Node's stat poll notices a write.
test(
  'stat subscribers share one watch, each hears a change, and a closed one stops hearing them',
  t => {
    const path = join(
      tmpdir(),
      'pnyx-stat-watch',
      'transcript',
    )
    const listeners: (() => void)[] = []
    const released: (() => void)[] = []
    t.mock.method(
      fs,
      'watchFile',
      // eslint-disable-next-line pnyx/object-params -- Node owns fs.watchFile's signature.
      (
        _path: string,
        _options: unknown,
        listener: () => void,
      ) => {
        listeners.push(listener)
      },
    )
    t.mock.method(
      fs,
      'unwatchFile',
      // eslint-disable-next-line pnyx/object-params -- Node owns fs.unwatchFile's signature.
      (
        _path: string,
        listener: () => void,
      ) => {
        released.push(listener)
      },
    )
    syncBuiltinESMExports()
    t.after(() => {
      t.mock.restoreAll()
      syncBuiltinESMExports()
    })
    const heard: number[] = []
    const watchers = Array.from(
      { length: SUBSCRIBERS },
      (
        _,
        index,
      ) => pollPath({
        path,
        interval: POLL_MS,
        changed: () => heard.push(index),
      }),
    )
    assert.equal(
      listeners.length,
      1,
    )
    listeners[0]!()
    assert.deepEqual(
      heard,
      Array.from(
        { length: SUBSCRIBERS },
        (
          _,
          index,
        ) => index,
      ),
    )

    watchers[0]!.close()
    watchers[0]!.close()
    heard.length = 0
    listeners[0]!()
    assert.deepEqual(
      heard,
      Array.from(
        { length: SUBSCRIBERS - 1 },
        (
          _,
          index,
        ) => index + 1,
      ),
    )
    assert.deepEqual(
      released,
      [],
    )

    watchers.forEach(watcher => watcher.close())
    assert.deepEqual(
      released,
      [listeners[0]],
    )

    for (let cycle = 0; cycle < SUBSCRIBERS; cycle++) {
      pollPath({
        path,
        interval: POLL_MS,
        changed: () => {},
      }).close()
    }

    assert.equal(
      listeners.length,
      1 + SUBSCRIBERS,
    )
    assert.deepEqual(
      released,
      listeners,
    )
    heard.length = 0
    const next = pollPath({
      path,
      interval: POLL_MS,
      changed: () => heard.push(-1),
    })
    t.after(() => next.close())
    watchers[0]!.close()
    listeners.at(-1)!()
    assert.deepEqual(
      heard,
      [-1],
    )
  },
)

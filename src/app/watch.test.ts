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

test(
  'shared stat subscribers follow replacements and stop receiving changes when closed',
  async t => {
    const root = fs.mkdtempSync(join(
      tmpdir(),
      'pnyx-stat-watch-',
    ))
    const path = join(
      root,
      'transcript',
    )
    fs.writeFileSync(
      path,
      'first',
    )
    const seen = new Map<number, string>()
    const watchers = Array.from(
      { length: SUBSCRIBERS },
      (
        _,
        index,
      ) => pollPath({
        path,
        interval: POLL_MS,
        changed: () => seen.set(
          index,
          fs.readFileSync(
            path,
            'utf8',
          ),
        ),
      }),
    )
    t.after(() => {
      watchers.forEach(watcher => watcher.close())
      fs.rmSync(
        root,
        {
          recursive: true,
          force: true,
        },
      )
    })
    // fs.watchFile reads its first stat asynchronously, so a write before that reading is its baseline, not a change;
    // writing again until every subscriber has seen one keeps the test from racing that first reading.
    await until({
      check: () => {
        if (seen.size < SUBSCRIBERS) {
          fs.writeFileSync(
            path,
            'second',
          )
        }

        return seen.size === SUBSCRIBERS
      },
    })
    assert.deepEqual(
      new Set(seen.values()),
      new Set(['second']),
    )
    watchers[0]!.close()
    watchers[0]!.close()
    seen.clear()
    fs.unlinkSync(path)
    fs.writeFileSync(
      path,
      'recreated',
    )
    await until({ check: () => seen.size === SUBSCRIBERS - 1 })
    assert.equal(
      seen.has(0),
      false,
    )
    assert.deepEqual(
      new Set(seen.values()),
      new Set(['recreated']),
    )
    watchers.forEach(watcher => watcher.close())
    seen.clear()

    for (let cycle = 0; cycle < SUBSCRIBERS; cycle++) {
      const owner = pollPath({
        path,
        interval: POLL_MS,
        changed: () => {},
      })
      owner.close()
    }

    let reopened = ''
    const next = pollPath({
      path,
      interval: POLL_MS,
      changed: () => reopened = fs.readFileSync(
        path,
        'utf8',
      ),
    })
    t.after(() => next.close())
    watchers[0]!.close()
    fs.writeFileSync(
      path,
      'after reopening',
    )
    await until({ check: () => reopened === 'after reopening' })
    assert.equal(
      seen.size,
      0,
    )
  },
)

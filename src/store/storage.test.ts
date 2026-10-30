import assert from 'node:assert/strict'
import fs, { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { acquireLock, writeDurably } from './storage.ts'

test(
  'durable writes complete short filesystem writes and refuse a write that stops making progress',
  t => {
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-short-write-',
    ))
    const path = join(
      root,
      'events.jsonl',
    )
    const write = fs.writeSync
    const chunkBytes = 3
    t.after(() => {
      t.mock.restoreAll()
      syncBuiltinESMExports()
      rmSync(
        root,
        {
          recursive: true,
          force: true,
        },
      )
    })
    t.mock.method(
      fs,
      'writeSync',
      // eslint-disable-next-line pnyx/object-params -- preserves the fs API signature.
      (
        fd: number,
        buffer: Buffer,
        offset: number,
        length: number,
      ) => write(
        fd,
        buffer,
        offset,
        Math.min(
          chunkBytes,
          length,
        ),
      ),
    )
    syncBuiltinESMExports()
    writeDurably({
      path,
      data: 'one complete transaction\n',
      flag: 'a',
    })
    assert.equal(
      readFileSync(
        path,
        'utf8',
      ),
      'one complete transaction\n',
    )
    t.mock.restoreAll()
    t.mock.method(
      fs,
      'writeSync',
      () => 0,
    )
    syncBuiltinESMExports()
    assert.throws(
      () => writeDurably({
        path,
        data: 'another transaction\n',
        flag: 'a',
      }),
      /write made no progress/,
    )
    assert.equal(
      readFileSync(
        path,
        'utf8',
      ),
      'one complete transaction\n',
    )
  },
)

test(
  'an abandoned empty writer lock becomes recoverable within one blocking acquisition',
  t => {
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-empty-lock-',
    ))
    t.after(() => rmSync(
      root,
      {
        recursive: true,
        force: true,
      },
    ))
    const path = join(
      root,
      'writer.lock',
    )
    fs.writeFileSync(
      path,
      '',
    )
    const emptyLockGraceMs = 10_000
    const remainingGraceMs = 1000
    const created = new Date(Date.now() - emptyLockGraceMs + remainingGraceMs)
    fs.utimesSync(
      path,
      created,
      created,
    )
    assert.throws(
      () => acquireLock({
        dir: root,
        timeout: 0,
      }),
      { code: 'LOCKED' },
    )
    const release = acquireLock({
      dir: root,
      timeout: 5,
    })
    assert.equal(
      readFileSync(
        path,
        'utf8',
      ),
      String(process.pid),
    )
    release()
    assert.equal(
      fs.existsSync(path),
      false,
    )
  },
)

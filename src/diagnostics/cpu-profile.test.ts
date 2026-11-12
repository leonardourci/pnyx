import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureCpuProfile, profileFunctions } from './cpu-profile.ts'

test(
  'CPU capture saves a private usable profile, rejects overlap and invalid durations, and cancels cleanly',
  async t => {
    const root = mkdtempSync(join(
      tmpdir(),
      'pnyx-cpu-profile-',
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
      'idle.cpuprofile',
    )
    await assert.rejects(
      captureCpuProfile({
        seconds: 0,
        path,
      }),
      {code: 'VALIDATION_ERROR'},
    )
    const running = captureCpuProfile({
      seconds: 1,
      path,
    })
    await assert.rejects(
      captureCpuProfile({
        seconds: 1,
        path,
      }),
      {code: 'BUSY'},
    )
    const result = await running
    const saved = JSON.parse(readFileSync(
      path,
      'utf8',
    ))
    assert.ok(saved.nodes.length > 0)
    assert.ok(saved.samples.length > 0)
    assert.ok(result.functions.length > 0)
    assert.equal(
      statSync(path).mode & 0o777,
      0o600,
    )
    const original = readFileSync(path)
    await assert.rejects(
      captureCpuProfile({
        seconds: 1,
        path,
      }),
      { code: 'ALREADY_EXISTS' },
    )
    assert.deepEqual(
      readFileSync(path),
      original,
    )
    const race = join(
      root,
      'racing.cpuprofile',
    )
    let reserve = true
    const open = fs.openSync
    t.mock.method(
      fs,
      'openSync',
      // eslint-disable-next-line pnyx/object-params -- Node owns fs.openSync's signature.
      (...args: Parameters<typeof fs.openSync>) => {
        if (String(args[0]) === race && reserve) {
          reserve = false
          writeFileSync(
            race,
            'Reserved by another writer',
          )
        }

        return open(...args)
      },
    )
    syncBuiltinESMExports()
    t.after(() => {
      t.mock.restoreAll(); syncBuiltinESMExports()
    })
    await assert.rejects(
      captureCpuProfile({
        seconds: 1,
        path: race,
      }),
      { code: 'EEXIST' },
    )
    assert.equal(
      readFileSync(
        race,
        'utf8',
      ),
      'Reserved by another writer',
    )
    t.mock.restoreAll()
    syncBuiltinESMExports()
    const cancelled = join(
      root,
      'cancelled.cpuprofile',
    )
    const abort = new AbortController()
    const pending = captureCpuProfile({
      seconds: 60,
      path: cancelled,
      signal: abort.signal,
    })
    abort.abort()
    await assert.rejects(
      pending,
      {name: 'AbortError'},
    )
    assert.equal(
      existsSync(cancelled),
      false,
    )
    assert.ok((await captureCpuProfile({
      seconds: 1,
      path: join(
        root,
        'after-cancel.cpuprofile',
      ),
    })).samples > 0)
  },
)

test(
  'profile functions use sample durations rather than treating every sample as equal',
  () => {
    const frame = {
      functionName: 'work',
      scriptId: '1',
      url: 'file:///synthetic/app.ts',
      lineNumber: 4,
      columnNumber: 0,
    }
    const rows = profileFunctions({
      profile: {
        startTime: 0,
        endTime: 1000,
        nodes: [
          {
            id: 1,
            callFrame: {
              ...frame,
              functionName: '(idle)',
              url: '',
              lineNumber: -1,
            },
          },
          {
            id: 2,
            callFrame: frame,
          },
        ],
        samples: [
          1,
          2,
        ],
        timeDeltas: [
          100,
          900,
        ],
      },
    })
    assert.deepEqual(
      rows,
      [
        {
          function: 'work',
          file: 'file:///synthetic/app.ts',
          line: 5,
          samples: 1,
          selfMs: 1,
          percent: 90,
        },
        {
          function: '(idle)',
          file: '',
          line: 0,
          samples: 1,
          selfMs: 0,
          percent: 10,
        },
      ],
    )
  },
)

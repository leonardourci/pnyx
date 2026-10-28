import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, test } from 'node:test'
import type { HydraEvent } from './model.ts'
import { HydraError } from '../core/model.ts'
import { emptyHydra, replay } from './reducer.ts'
import { hydraDir, hydraIds } from './home-migration.ts'
import { loadHydra } from './store.ts'
import { readEvents } from './event-log.ts'
import { repairHydra } from './repair.ts'
import { withWriter } from './writer.ts'
import { acquireLock } from '../store/storage.ts'
import { STREAMS, assertGolden, readStream } from '../test-harness/streams.ts'

beforeEach(() => {
  process.env.PNYX_HOME = mkdtempSync(join(
    tmpdir(),
    'pnyx-store-',
  ))
})

const rejects = ({
  fn,
  code,
}: {
  fn: () => unknown
  code: string
}) =>
  assert.throws(
    fn,
    (error: unknown) => error instanceof HydraError && error.code === code,
  )

function appendAll({ events }: { events: HydraEvent[] }): void {
  withWriter({
    hydraId: 'default',
    fn: ({ writer }) => events.forEach(e => writer.append({ event: e })),
  })
}

function seedLog({ stream }: { stream: string }): string {
  const dir = hydraDir({ hydraId: 'default' })
  mkdirSync(
    dir,
    { recursive: true },
  )
  copyFileSync(
    join(
      STREAMS,
      `${stream}.jsonl`,
    ),
    join(
      dir,
      'events.jsonl',
    ),
  )

  return dir
}

test(
  'appends are durable lines and the snapshot matches a full replay',
  () => {
    const events = readStream({ name: 'lifecycle' })
    appendAll({ events })
    const dir = hydraDir({ hydraId: 'default' })
    const lines = readFileSync(
      join(
        dir,
        'events.jsonl',
      ),
      'utf8',
    ).trimEnd()
      .split('\n')
    const written: HydraEvent[] = lines.map(l => JSON.parse(l))
    assert.ok(written.every(e => e.boardId === 'default' && e.commandId === e.id))
    // Each line holds the appended event plus the denormalized ids.
    assert.deepEqual(
      written.map((
        e,
        i,
      ) => ({
        ...e,
        ...events[i],
      })),
      written,
    )
    assert.equal(
      written.length,
      events.length,
    )
    const expected = replay({
      state: emptyHydra(),
      events: readEvents({ hydraId: 'default' }),
    })
    assert.deepEqual(
      loadHydra({ hydraId: 'default' }).state,
      expected,
    )
    const snapshot = JSON.parse(readFileSync(
      join(
        dir,
        'snapshot.json',
      ),
      'utf8',
    ))
    assert.deepEqual(
      snapshot.state,
      expected,
    )
  },
)

test(
  'a missing, corrupt or stale snapshot is rebuilt from the log',
  () => {
    const events = readStream({ name: 'lifecycle' })
    appendAll({
      events: events.slice(
        0,
        4,
      ),
    })
    const dir = hydraDir({ hydraId: 'default' })
    const early = readFileSync(join(
      dir,
      'snapshot.json',
    ))
    appendAll({ events: events.slice(4) })
    const expected = replay({
      state: emptyHydra(),
      events: readEvents({ hydraId: 'default' }),
    })

    // Crash between the append and the snapshot write: the old snapshot plus the log tail.
    writeFileSync(
      join(
        dir,
        'snapshot.json',
      ),
      early,
    )
    assert.deepEqual(
      loadHydra({ hydraId: 'default' }).state,
      expected,
    )
    writeFileSync(
      join(
        dir,
        'snapshot.json',
      ),
      '{not json',
    )
    assert.deepEqual(
      loadHydra({ hydraId: 'default' }).state,
      expected,
    )
    rmSync(join(
      dir,
      'snapshot.json',
    ))
    assert.deepEqual(
      loadHydra({ hydraId: 'default' }).state,
      expected,
    )
  },
)

test(
  'appends must continue the sequence',
  () => {
    appendAll({
      events: readStream({ name: 'lifecycle' }).slice(
        0,
        1,
      ),
    })
    const [
      , second,
    ] = readStream({ name: 'lifecycle' })
    assert.throws(
      () => appendAll({
        events: [
          {
            ...second!,
            seq: 5,
          },
        ],
      }),
      /out of sequence/,
    )
  },
)

test(
  'a torn tail is skipped on read, blocks writes and is set aside by repair',
  () => {
    const dir = seedLog({ stream: 'torn-tail' })
    const original = readFileSync(join(
      dir,
      'events.jsonl',
    ))
    const clean = original.subarray(
      0,
      original.lastIndexOf(10) + 1,
    )

    const loaded = loadHydra({ hydraId: 'default' })
    assert.equal(
      loaded.state.seq,
      3,
    )
    assert.equal(
      loaded.tornBytes,
      original.length - clean.length,
    )
    assertGolden({
      name: 'torn-tail',
      actual: loaded.state,
    })
    rejects({
      fn: () => withWriter({
        hydraId: 'default',
        fn: () => undefined,
      }),
      code: 'TORN_TAIL',
    })

    const result = repairHydra({ hydraId: 'default' })
    assert.equal(
      result.tornBytes,
      loaded.tornBytes,
    )
    assert.deepEqual(
      readFileSync(result.preserved!),
      original.subarray(clean.length),
    )
    const repaired = readFileSync(join(
      dir,
      'events.jsonl',
    ))
    assert.deepEqual(
      repaired.subarray(
        0,
        original.length,
      ),
      original,
    )
    const marker = JSON.parse(repaired.subarray(original.length + 1).toString('utf8'))
    assert.deepEqual(
      marker.data,
      {
        offset: clean.length,
        length: original.length - clean.length,
      },
    )
    assert.equal(
      loadHydra({ hydraId: 'default' }).tornBytes,
      0,
    )
  },
)

test(
  'repeated reads return appended events, honour a repair and notice a new file',
  () => {
    const events = readStream({ name: 'lifecycle' })
    const ids = () => readEvents({ hydraId: 'default' }).map(e => e.id)
    appendAll({
      events: events.slice(
        0,
        2,
      ),
    })
    assert.deepEqual(
      ids(),
      [
        'evt_1',
        'evt_2',
      ],
    )
    appendAll({ events: events.slice(2) })
    assert.deepEqual(
      ids(),
      events.map(e => e.id),
    )

    const path = join(
      hydraDir({ hydraId: 'default' }),
      'events.jsonl',
    )
    const ghost = JSON.stringify({
      ...events[0]!,
      seq: 99,
      id: 'evt_99',
    })
    writeFileSync(
      path,
      readFileSync(
        path,
        'utf8',
      ) + ghost,
    )
    repairHydra({ hydraId: 'default' })
    assert.deepEqual(
      ids(),
      events.map(e => e.id),
    )

    rmSync(path)
    assert.deepEqual(
      ids(),
      [],
    )
    appendAll({
      events: events.slice(
        0,
        1,
      ),
    })
    assert.deepEqual(
      ids(),
      ['evt_1'],
    )
  },
)

test(
  'repair skips a torn line even when it parses as an event',
  () => {
    const dir = seedLog({ stream: 'lifecycle' })
    const events = readStream({ name: 'lifecycle' })
    const unacknowledged = JSON.stringify({
      ...events[0]!,
      seq: 9,
      id: 'evt_9',
      data: { key: 'ghost' },
    })
    writeFileSync(
      join(
        dir,
        'events.jsonl',
      ),
      readFileSync(join(
        dir,
        'events.jsonl',
      )).toString() + unacknowledged,
    )
    repairHydra({ hydraId: 'default' })
    rmSync(join(
      dir,
      'snapshot.json',
    ))
    assert.deepEqual(
      loadHydra({ hydraId: 'default' }).state,
      replay({
        state: emptyHydra(),
        events: readEvents({ hydraId: 'default' }),
      }),
    )
  },
)

test(
  'a repair marker that names the wrong line is corruption',
  () => {
    const dir = seedLog({ stream: 'lifecycle' })
    const marker = {
      v: 1,
      type: 'log.repaired',
      at: '2026-10-13T00:00:00Z',
      data: {
        offset: 0,
        length: 1,
      },
    }
    writeFileSync(
      join(
        dir,
        'events.jsonl',
      ),
      `${readFileSync(join(
        dir,
        'events.jsonl',
      ))}${JSON.stringify(marker)}\n`,
    )
    rejects({
      fn: () => loadHydra({ hydraId: 'default' }),
      code: 'LOG_CORRUPT',
    })
  },
)

test(
  'corruption inside the log is rejected, not skipped',
  () => {
    const dir = seedLog({ stream: 'lifecycle' })
    const lines = readFileSync(
      join(
        dir,
        'events.jsonl',
      ),
      'utf8',
    ).split('\n')
    lines[2] = '{garbage'
    writeFileSync(
      join(
        dir,
        'events.jsonl',
      ),
      lines.join('\n'),
    )
    rejects({
      fn: () => loadHydra({ hydraId: 'default' }),
      code: 'LOG_CORRUPT',
    })
  },
)

test(
  'Hydra names cannot escape the Hydras folder',
  () => {
    rejects({
      fn: () => hydraDir({ hydraId: '../etc' }),
      code: 'VALIDATION_ERROR',
    })
    rejects({
      fn: () => hydraDir({ hydraId: 'a/b' }),
      code: 'VALIDATION_ERROR',
    })
  },
)

test(
  'a zero-timeout writer reclaims one stale lock without waiting',
  () => {
    const dir = mkdtempSync(join(
      tmpdir(),
      'pnyx-stale-immediate-',
    ))
    const path = join(
      dir,
      'writer.lock',
    )
    const dead = spawnSync(
      process.execPath,
      [
        '-e',
        '',
      ],
    ).pid
    writeFileSync(
      path,
      String(dead),
    )
    const release = acquireLock({
      dir,
      timeout: 0,
    })

    try {
      assert.equal(
        readFileSync(
          path,
          'utf8',
        ),
        String(process.pid),
      )
      assert.equal(
        existsSync(`${path}.takeover`),
        false,
      )
    } finally {
      release()
    }

    assert.equal(
      existsSync(path),
      false,
    )
  },
)

test(
  'writer lock expiry reports the live owner and leaves its lock intact',
  () => {
    const dir = mkdtempSync(join(
      tmpdir(),
      'pnyx-live-lock-',
    ))
    const path = join(
      dir,
      'writer.lock',
    )
    const owner = String(process.pid)
    writeFileSync(
      path,
      owner,
    )
    assert.throws(
      () => acquireLock({
        dir,
        timeout: 0,
      }),
      error => {
        assert.ok(error instanceof HydraError)
        assert.equal(
          error.code,
          'LOCKED',
        )
        assert.ok(error.message.includes(path))
        assert.ok(error.message.includes(`owner: ${owner}`))
        assert.match(
          error.message,
          /after 0ms/,
        )

        return true
      },
    )
    assert.equal(
      readFileSync(
        path,
        'utf8',
      ),
      owner,
    )
  },
)

test(
  'repeated stale writer takeovers obey the original deadline',
  t => {
    const dir = mkdtempSync(join(
      tmpdir(),
      'pnyx-stale-lock-',
    ))
    const path = join(
      dir,
      'writer.lock',
    )
    const open = fs.openSync
    let now = 0
    let attempts = 0
    t.mock.method(
      Date,
      'now',
      () => now,
    )
    t.mock.method(
      fs,
      'openSync',
      // eslint-disable-next-line pnyx/object-params -- preserves the fs API signature
      (...args: Parameters<typeof fs.openSync>) => {
        if (args[0] === path && args[1] === 'wx') {
          assert.ok(
            ++attempts <= 3,
            'takeovers must stop at the deadline',
          )
          now += 10
          writeFileSync(
            path,
            '2147483647',
          )
          throw Object.assign(
            new Error('another stale writer won'),
            { code: 'EEXIST' },
          )
        }

        return open(...args)
      },
    )
    syncBuiltinESMExports()

    try {
      rejects({
        fn: () => acquireLock({
          dir,
          timeout: 20,
        }),
        code: 'LOCKED',
      })
      assert.equal(
        attempts,
        2,
      )
      assert.equal(
        existsSync(`${path}.takeover`),
        false,
      )
    } finally {
      t.mock.restoreAll()
      syncBuiltinESMExports()
    }
  },
)

test(
  'a stale writer observation cannot remove a lock acquired before takeover',
  t => {
    const dir = hydraDir({ hydraId: 'default' })
    mkdirSync(
      dir,
      { recursive: true },
    )
    const path = join(
      dir,
      'writer.lock',
    )
    const dead = spawnSync(
      process.execPath,
      [
        '-e',
        '',
      ],
    ).pid
    writeFileSync(
      path,
      String(dead),
    )
    const read = fs.readFileSync
    let release: (() => void) | undefined
    let observed = false
    t.mock.method(
      fs,
      'readFileSync',
      // eslint-disable-next-line pnyx/object-params -- Node's fs callback keeps its positional API.
      (...args: Parameters<typeof read>) => {
        const result = read(...args)

        if (args[0] === path && !observed) {
          observed = true
          release = acquireLock({
            dir,
            timeout: 0,
          })
        }

        return result
      },
    )
    syncBuiltinESMExports()

    try {
      rejects({
        fn: () => acquireLock({
          dir,
          timeout: 0,
        }),
        code: 'LOCKED',
      })
      assert.equal(
        observed,
        true,
      )
      assert.equal(
        read(
          path,
          'utf8',
        ),
        String(process.pid),
      )
      assert.equal(
        existsSync(`${path}.takeover`),
        false,
      )
    } finally {
      release?.()
      t.mock.restoreAll()
      syncBuiltinESMExports()
    }

    assert.equal(
      existsSync(path),
      false,
    )
  },
)

test(
  'a second stale writer cannot enter while the takeover guard is held',
  t => {
    const dir = hydraDir({ hydraId: 'default' })
    mkdirSync(
      dir,
      { recursive: true },
    )
    const path = join(
      dir,
      'writer.lock',
    )
    const dead = spawnSync(
      process.execPath,
      [
        '-e',
        '',
      ],
    ).pid
    writeFileSync(
      path,
      String(dead),
    )
    const open = fs.openSync
    let contested = false
    t.mock.method(
      fs,
      'openSync',
      // eslint-disable-next-line pnyx/object-params -- Node's fs callback keeps its positional API.
      (...args: Parameters<typeof open>) => {
        const fd = open(...args)

        if (args[0] === `${path}.takeover` && !contested) {
          contested = true
          rejects({
            fn: () => acquireLock({
              dir,
              timeout: 0,
            }),
            code: 'LOCKED',
          })
          assert.equal(
            readFileSync(
              path,
              'utf8',
            ),
            String(dead),
          )
        }

        return fd
      },
    )
    syncBuiltinESMExports()
    let release: (() => void) | undefined

    try {
      release = acquireLock({
        dir,
        timeout: 0,
      })
      assert.equal(
        contested,
        true,
      )
      assert.equal(
        readFileSync(
          path,
          'utf8',
        ),
        String(process.pid),
      )
      assert.equal(
        existsSync(`${path}.takeover`),
        false,
      )
    } finally {
      release?.()
      t.mock.restoreAll()
      syncBuiltinESMExports()
    }

    assert.equal(
      existsSync(path),
      false,
    )
  },
)

test(
  'a Hydra in the old boards folder moves to hydras and its events replay',
  () => {
    const old = join(
      process.env.PNYX_HOME!,
      'boards',
      'existing',
    )
    const dir = join(
      process.env.PNYX_HOME!,
      'hydras',
      'existing',
    )
    mkdirSync(
      old,
      { recursive: true },
    )
    const config = {
      id: 'existing',
      name: 'Existing work',
      hydra: {
        id: 'lead',
        kind: 'agent',
        name: 'Hydra',
      },
      columns: [
        {
          id: 'parked',
          title: 'Later',
          role: 'parked',
        },
      ],
    }
    const log = [
      {
        v: 1,
        seq: 1,
        id: 'configured',
        at: '2026-10-01T00:00:00Z',
        actor: 'cli',
        cardId: '$board',
        boardId: 'existing',
        type: 'board.configured',
        data: config,
      },
      {
        v: 1,
        seq: 2,
        id: 'task',
        at: '2026-10-01T00:00:01Z',
        actor: 'cli',
        cardId: 't1',
        boardId: 'existing',
        type: 'task.created',
        data: {
          key: 'work',
          title: 'Keep this task',
        },
      },
      {
        v: 1,
        seq: 3,
        id: 'memory',
        at: '2026-10-01T00:00:02Z',
        actor: 'cli',
        cardId: '$board',
        boardId: 'existing',
        type: 'hydra.memory',
        data: {
          key: 'rule',
          before: null,
          after: 'Keep this fact',
        },
      },
    ].map(event => JSON.stringify(event)).join('\n') + '\n'
    writeFileSync(
      join(
        old,
        'events.jsonl',
      ),
      log,
    )
    writeFileSync(
      join(
        old,
        'snapshot.json',
      ),
      JSON.stringify({
        v: 1,
        rules: 7,
        offset: Buffer.byteLength(log),
        state: {
          ...emptyHydra(),
          seq: 3,
          board: config,
          boardRevision: 1,
        },
      }),
    )

    const loaded = loadHydra({ hydraId: 'existing' })
    assert.equal(
      loaded.dir,
      dir,
    )
    assert.equal(
      existsSync(join(
        process.env.PNYX_HOME!,
        'boards',
      )),
      false,
    )
    assert.equal(
      loaded.state.config?.name,
      'Existing work',
    )
    assert.equal(
      loaded.state.cards.t1?.title,
      'Keep this task',
    )
    assert.equal(
      loaded.state.hydraMemory?.rule?.text,
      'Keep this fact',
    )
    repairHydra({ hydraId: 'existing' })
    assert.equal(
      readFileSync(
        join(
          dir,
          'events.jsonl',
        ),
        'utf8',
      ),
      log,
    )
    assert.deepEqual(
      loadHydra({ hydraId: 'existing' }).state,
      loaded.state,
    )
  },
)

const seed = ({ files }: { files: Record<string, string> }) => {
  for (const [
    name,
    text,
  ] of Object.entries(files)) {
    mkdirSync(
      join(
        process.env.PNYX_HOME!,
        name,
        '..',
      ),
      { recursive: true },
    )
    writeFileSync(
      join(
        process.env.PNYX_HOME!,
        name,
      ),
      text,
    )
  }
}

for (const removed of [
  true,
  false,
]) {
  test(
    `a migration lock open returning EINVAL ${removed ? 'after removal uses the moved Hydras' : 'with the directory present stays visible'}`,
    t => {
      const home = process.env.PNYX_HOME!
      const boards = join(
        home,
        'boards',
      )
      const hydras = join(
        home,
        'hydras',
      )
      seed({ files: { 'boards/one/events.jsonl': 'preserved\n' } })
      const originalOpen = fs.openSync
      const failure = Object.assign(
        new Error('exclusive open failed'),
        { code: 'EINVAL' },
      )
      const opening = t.mock.method(
        fs,
        'openSync',
        // eslint-disable-next-line pnyx/object-params -- The mock keeps fs.openSync's external signature.
        (...args: Parameters<typeof fs.openSync>) => {
          if (args[0] === join(
            boards,
            'writer.lock',
          )) {
            if (removed) {
              fs.renameSync(
                boards,
                hydras,
              )
            }

            throw failure
          }

          return originalOpen(...args)
        },
      )
      syncBuiltinESMExports()
      t.after(() => {
        opening.mock.restore()
        syncBuiltinESMExports()
      })

      if (!removed) {
        assert.throws(
          () => hydraIds(),
          error => error === failure,
        )
        assert.equal(
          readFileSync(
            join(
              boards,
              'one/events.jsonl',
            ),
            'utf8',
          ),
          'preserved\n',
        )

        return
      }

      assert.deepEqual(
        hydraIds(),
        ['one'],
      )
      assert.equal(
        readFileSync(
          join(
            hydras,
            'one/events.jsonl',
          ),
          'utf8',
        ),
        'preserved\n',
      )
      assert.equal(
        existsSync(boards),
        false,
      )
    },
  )
}

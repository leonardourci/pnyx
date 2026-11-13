import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, test } from 'node:test'
import type { HydraEvent } from './model.ts'
import { HydraError } from '#store/errors.ts'
import { query } from '#store/postgres.ts'
import { emptyHydra, replay } from './reducer.ts'
import { hydraDir, hydraIds } from './home-migration.ts'
import { heldHydra, holdHydra, loadHydra, reloadHydra } from './store.ts'
import { readEvents, readEventsFrom } from './event-log.ts'
import { withWriter } from './writer.ts'
import { acquireLock } from '#store/storage.ts'
import { STREAMS, readStream } from '#test-harness/streams.ts'

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

const storedEvents = () => Number(query({
  statements: [{ text: 'select count(*) as count from events where hydra_id = \'default\'' }],
})[0]![0]!.count)

// What the state holds once saved as JSON: fields set to undefined are gone.
const saved = ({ value }: { value: unknown }) => JSON.parse(JSON.stringify(value))

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
  'a command commits its events with the rows they change, and the Hydra reloads as a full replay',
  () => {
    const events = readStream({ name: 'lifecycle' })
    appendAll({ events })
    const written = readEvents({ hydraId: 'default' })
    assert.ok(written.every(e => e.boardId === 'default' && e.commandId === e.id))
    assert.equal(
      storedEvents(),
      events.length,
    )
    reloadHydra({ hydraId: 'default' })
    assert.deepEqual(
      saved({ value: loadHydra({ hydraId: 'default' }).state }),
      saved({
        value: replay({
          state: emptyHydra(),
          events: written,
        }),
      }),
    )
  },
)

test(
  'rows saved one command at a time reload as the state in memory for every recorded stream',
  () => {
    for (const name of readdirSync(STREAMS).filter(file => file.endsWith('.jsonl'))
      .map(file => file.slice(
        0,
        -'.jsonl'.length,
      ))) {
      const hydraId = `stream-${name}`

      const events = readStream({ name })

      // The duplicates stream repeats and skips seqs to test the reducer; a writer takes only the next one.
      if (events.some((
        event,
        index,
      ) => event.seq !== index + 1)) {
        continue
      }

      for (const event of events) {
        withWriter({
          hydraId,
          create: true,
          migrate: false,
          fn: ({ writer }) => writer.append({
            event,
            effects: false,
          }),
        })
      }

      const live = saved({ value: loadHydra({ hydraId }).state })
      reloadHydra({ hydraId })
      assert.deepEqual(
        saved({ value: loadHydra({ hydraId }).state }),
        live,
        name,
      )
    }
  },
)

test(
  'a command that throws commits none of its events',
  () => {
    const [
      first,
      second,
    ] = readStream({ name: 'lifecycle' })
    appendAll({ events: [first!] })
    assert.throws(
      () => withWriter({
        hydraId: 'default',
        fn: ({ writer }) => {
          writer.append({ event: second! })
          throw new Error('stopped midway')
        },
      }),
      /stopped midway/,
    )
    assert.equal(
      storedEvents(),
      1,
    )
    assert.equal(
      loadHydra({ hydraId: 'default' }).state.seq,
      first!.seq,
    )
  },
)

test(
  'a held Hydra whose seq another writer moved refuses the write at the database and reloads',
  () => {
    const [
      first,
      second,
    ] = readStream({ name: 'lifecycle' })
    appendAll({ events: [first!] })
    let changes = 0
    const release = holdHydra({
      hydraId: 'default',
      changed: () => {
        changes += 1
      },
    })

    try {
      query({ statements: [{ text: 'update hydras set seq = seq + 1 where id = \'default\'' }] })
      rejects({
        fn: () => appendAll({ events: [second!] }),
        code: 'CONFLICT',
      })
      // The server learns that the held state was read back, so it stops showing the refused event.
      assert.equal(
        changes,
        1,
      )
      assert.equal(
        heldHydra({ hydraId: 'default' })?.state.eventIds[second!.id],
        undefined,
      )
      assert.equal(
        storedEvents(),
        1,
      )
      assert.equal(
        loadHydra({ hydraId: 'default' }).state.seq,
        first!.seq + 1,
      )
    } finally {
      release()
    }
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
  'a Hydra kept in events.jsonl is imported on its first read and the file is left as it was',
  () => {
    const dir = seedLog({ stream: 'lifecycle' })
    const before = readFileSync(join(
      dir,
      'events.jsonl',
    ))
    const events = readStream({ name: 'lifecycle' })
    assert.deepEqual(
      saved({ value: loadHydra({ hydraId: 'default' }).state }),
      saved({
        value: replay({
          state: emptyHydra(),
          events,
        }),
      }),
    )
    reloadHydra({ hydraId: 'default' })
    loadHydra({ hydraId: 'default' })
    assert.equal(
      storedEvents(),
      events.length,
    )
    assert.deepEqual(
      readFileSync(join(
        dir,
        'events.jsonl',
      )),
      before,
    )
  },
)

test(
  'event reads after a seq stop at their limit and at through',
  () => {
    const events = readStream({ name: 'lifecycle' })
    appendAll({ events })
    const second = events[1]!.seq
    const read = readEventsFrom({
      hydraId: 'default',
      offset: events[0]!.seq,
      limit: 2,
    })
    assert.deepEqual(
      read.events.map(event => event.seq),
      events.slice(
        1,
        3,
      ).map(event => event.seq),
    )
    assert.equal(
      read.end,
      events[2]!.seq,
    )
    assert.deepEqual(
      readEventsFrom({
        hydraId: 'default',
        offset: 0,
        through: second,
      }).events.map(event => event.seq),
      [
        events[0]!.seq,
        second,
      ],
    )
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
  'a Hydra in the old boards folder moves to hydras and its events are imported',
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
    reloadHydra({ hydraId: 'existing' })
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

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { spawnSync } from 'node:child_process'
import { withWriter } from '#app/writer.ts'
import { loadHydra } from '#app/store.ts'
import { hydraDir } from '#app/home-migration.ts'
import { query } from '#store/postgres.ts'
import { storedHydra } from '#test-harness/database.ts'
import { decidePush } from '#tasks/push.ts'
import { search } from './search.ts'
import { searchPath } from './index.ts'

const CHECKPOINT_WORDS = 20_000
const TAIL_WORDS = 100_000
const PEER_SEARCH_TIMEOUT_MS = 10_000

const nativeLine = ({ text }: { text: string }) => `${JSON.stringify({
  type: 'user',
  message: {
    role: 'user',
    content: text,
  },
})}\n`

const find = ({ text }: { text: string }) => search({
  hydraId: 'default',
  query: {
    text,
    limit: 20,
  },
})

const note = ({
  card,
  id,
  text,
}: {
  card: string
  id: string
  text: string
}) => withWriter({
  hydraId: 'default',
  fn: ({ writer }) => {
    const base = {
      v: 1 as const,
      cardId: card,
      actor: 'fixture',
      at: '2026-11-12T10:00:00Z',
    }

    if (!writer.state.cards[card]) {
      writer.append({
        event: {
          ...base,
          seq: writer.state.seq + 1,
          id: `create-${id}`,
          type: 'task.created',
          data: {
            key: card,
            title: 'Noted task',
          },
        },
      })
    }

    writer.append({
      event: {
        ...base,
        seq: writer.state.seq + 1,
        id,
        type: 'card.noted',
        data: {
          text,
          kind: 'context',
          source: 'fixture',
        },
      },
    })
  },
})

function temporaryHome({
  t,
  prefix,
}: {
  t: TestContext
  prefix: string
}) {
  const root = fs.mkdtempSync(join(
    tmpdir(),
    prefix,
  ))
  const previous = process.env.PNYX_HOME
  process.env.PNYX_HOME = root
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()

    if (previous === undefined) {
      delete process.env.PNYX_HOME
    } else {
      process.env.PNYX_HOME = previous
    }

    fs.rmSync(
      root,
      {
        recursive: true,
        force: true,
      },
    )
  })

  return root
}

// A task whose transcript holds two lines, one of them already archived as an event, and a cache
// that has caught up with both.
function transcriptTask({ t }: { t: TestContext }) {
  const root = temporaryHome({
    t,
    prefix: 'oracle-deltas-',
  })
  const native = join(
    root,
    'session.jsonl',
  )
  assert.deepEqual(
    find({ text: 'emptyneedle' }).hits,
    [],
  )
  fs.writeFileSync(
    native,
    nativeLine({ text: 'initialneedle' }) + nativeLine({ text: 'ephemeralneedle' }),
  )
  const created = withWriter({
    hydraId: 'default',
    fn: ({ writer }) => {
      const decision = decidePush({
        state: writer.state,
        key: 'index',
        input: {
          title: 'Delta task',
          activity: 'finished',
          agent: {
            provider: 'claude-code',
            sessionId: 'delta',
            transcriptPath: native,
          },
        },
        meta: {
          actor: 'fixture',
          at: '2026-11-12T10:00:00Z',
        },
      })
      assert.ok('event' in decision)
      writer.append({ event: decision.event })

      return { card: decision.event.cardId }
    },
  })
  chat({
    card: created.card,
    id: 'archived-original',
    nativeId: '0:m0',
    text: 'initialneedle',
  })
  assert.equal(
    find({ text: 'initialneedle' }).hits[0]?.card,
    created.card,
  )

  return {
    ...created,
    native,
  }
}

function chat({
  card,
  id,
  nativeId,
  text,
  replaces,
}: {
  card: string
  id: string
  nativeId: string
  text: string
  replaces?: string
}) {
  withWriter({
    hydraId: 'default',
    fn: ({ writer }) => writer.append({
      event: {
        v: 1,
        seq: writer.state.seq + 1,
        id,
        actor: 'fixture',
        at: '2026-11-12T10:00:01Z',
        cardId: card,
        type: 'chat.message',
        data: {
          session: 'claude-code:delta',
          nativeId,
          role: 'user',
          text,
          replaces,
        },
      },
    }),
  })
}

// Records every read of the transcript, and lets a test fail or change it mid-read.
function watchReads({
  t,
  task,
}: {
  t: TestContext
  task: ReturnType<typeof transcriptTask>
}) {
  const descriptors = new Map<number, string>()
  const reads: {
    path: string
    position: number | null
    length: number
  }[] = []
  const hooks = {
    truncateAfterRead: false,
    appendWhileReading: false,
    failNativeRead: false,
    failFromPosition: 0,
    overlapNative: false,
  }

  const peerSearch = ({ text }: { text: string }) => {
    const source = new URL(
      './search.ts',
      import.meta.url,
    ).href
    const input = JSON.stringify({
      hydraId: 'default',
      query: {
        text,
        limit: 20,
      },
    })
    const answer = spawnSync(
      process.execPath,
      [
        '--conditions=source',
        '-e',
        `import { search } from ${JSON.stringify(source)}; process.stdout.write(JSON.stringify(search(${input})));`,
      ],
      {
        encoding: 'utf8',
        timeout: PEER_SEARCH_TIMEOUT_MS,
      },
    )
    assert.equal(
      answer.status,
      0,
      answer.stderr,
    )
    assert.equal(
      JSON.parse(answer.stdout).hits[0]?.card,
      task.card,
    )
  }

  const open = fs.openSync
  const read = fs.readSync
  const close = fs.closeSync
  const stat = fs.statSync
  t.mock.method(
    fs,
    'statSync',
    // eslint-disable-next-line pnyx/object-params -- Node owns fs.statSync's signature.
    (
      path: fs.PathLike,
      options?: fs.StatOptions,
    ) => {
      const found = stat(
        path,
        options,
      )

      if (hooks.overlapNative && String(path) === task.native) {
        hooks.overlapNative = false
        peerSearch({ text: 'overlapnative' })
      }

      return found
    },
  )
  t.mock.method(
    fs,
    'openSync',
    // eslint-disable-next-line pnyx/object-params -- Node owns fs.openSync's signature.
    (
      path: fs.PathLike,
      flags: fs.OpenMode,
      mode?: fs.Mode,
    ) => {
      const fd = open(
        path,
        flags,
        mode,
      )
      descriptors.set(
        fd,
        String(path),
      )

      return fd
    },
  )
  t.mock.method(
    fs,
    'closeSync',
    // eslint-disable-next-line pnyx/object-params -- Node owns fs.closeSync's signature.
    (fd: number) => {
      descriptors.delete(fd)

      return close(fd)
    },
  )
  t.mock.method(
    fs,
    'readSync',
    // eslint-disable-next-line pnyx/object-params -- Node owns fs.readSync's signature.
    (
      fd: number,
      buffer: NodeJS.ArrayBufferView,
      offset: number,
      length: number,
      position: number | null,
    ) => {
      const path = descriptors.get(fd)

      const nativeRead = path === task.native && length > 0
      const pastFailure = position !== null && position >= hooks.failFromPosition

      if (hooks.appendWhileReading && nativeRead) {
        hooks.appendWhileReading = false
        fs.appendFileSync(
          task.native,
          nativeLine({ text: 'futuremarker' }),
        )
      }

      if (hooks.failNativeRead && nativeRead && pastFailure) {
        throw new Error('Synthetic native read failure')
      }

      if (nativeRead) {
        reads.push({
          path,
          position,
          length,
        })
      }

      const bytes = read(
        fd,
        buffer,
        offset,
        length,
        position,
      )

      if (hooks.truncateAfterRead && nativeRead) {
        hooks.truncateAfterRead = false
        fs.writeFileSync(
          task.native,
          nativeLine({ text: 'truncatedmarker' }),
        )
      }

      return bytes
    },
  )
  syncBuiltinESMExports()

  return {
    reads,
    hooks,
  }
}

test(
  'Oracle removes the retired index and rebuilds its cache when the Hydra under it was replaced',
  t => {
    temporaryHome({
      t,
      prefix: 'oracle-replaced-log-',
    })
    note({
      card: 'task-noted',
      id: 'old-note',
      text: 'formerlogword',
    })
    note({
      card: 'task-noted',
      id: 'old-second',
      text: 'formersecondword',
    })
    assert.equal(
      find({ text: 'formerlogword' }).total,
      1,
    )
    const dir = hydraDir({ hydraId: 'default' })
    const retired = join(
      dir,
      'search.db',
    )
    fs.writeFileSync(
      retired,
      'old index',
    )
    find({ text: 'formerlogword' })
    assert.equal(
      fs.existsSync(retired),
      false,
      'a query removes the retired full-text index',
    )
    query({
      statements: [
        {
          text: 'delete from hydras where id = $1',
          values: ['default'],
        },
      ],
    })

    note({
      card: 'task-noted',
      id: 'new-note',
      text: 'replacedlogword',
    })
    assert.equal(
      find({ text: 'replacedlogword' }).total,
      1,
    )
    assert.equal(
      find({ text: 'formerlogword' }).total,
      0,
    )
  },
)

test(
  'a correction removes its older entry after a query indexed it',
  t => {
    const task = transcriptTask({ t })
    chat({
      card: task.card,
      id: 'earlier-record',
      nativeId: 'earlier',
      text: 'zinnia',
    })
    assert.equal(
      find({ text: 'zinnia*' }).hits[0]?.card,
      task.card,
    )
    chat({
      card: task.card,
      id: 'newer-record',
      nativeId: 'newer',
      text: 'quartz',
      replaces: 'earlier-record',
    })
    assert.equal(
      find({ text: 'quartz*' }).hits[0]?.card,
      task.card,
    )
    assert.equal(
      find({ text: 'zinnia*' }).total,
      0,
    )
  },
)

test(
  'an unchanged query reads no transcript bytes and needs no cache write lock',
  t => {
    const task = transcriptTask({ t })
    const { reads } = watchReads({
      t,
      task,
    })
    assert.equal(
      find({ text: 'initialneedle' }).hits[0]?.card,
      task.card,
    )
    assert.equal(
      reads.length,
      0,
      'an unchanged query reads no transcript bytes',
    )
    const locked = new DatabaseSync(searchPath({ hydraId: 'default' }))
    locked.exec('BEGIN IMMEDIATE')

    try {
      assert.equal(
        find({ text: 'initialneedle' }).hits[0]?.card,
        task.card,
        'an unchanged query needs no cache write lock',
      )
    } finally {
      locked.exec('ROLLBACK')
      locked.close()
    }
  },
)

test(
  'a failed transcript read keeps the committed batch and the retry reads only new bytes',
  t => {
    const task = transcriptTask({ t })
    const nativeSize = fs.statSync(task.native).size
    const {
      reads,
      hooks,
    } = watchReads({
      t,
      task,
    })
    const checkpoint = nativeLine({ text: 'checkpoint '.repeat(CHECKPOINT_WORDS) })
    const throughCheckpoint = nativeSize + Buffer.byteLength(checkpoint)
    fs.appendFileSync(
      task.native,
      checkpoint,
    )
    fs.appendFileSync(
      task.native,
      nativeLine({ text: `appendedneedle ${'tail '.repeat(TAIL_WORDS)}` }),
    )
    hooks.failFromPosition = throughCheckpoint
    note({
      card: task.card,
      id: 'delta-note',
      text: 'incrementalnote',
    })
    hooks.failNativeRead = true

    try {
      assert.throws(
        () => find({ text: 'appendedneedle incrementalnote' }),
        /Synthetic native read failure/,
      )
    } finally {
      hooks.failNativeRead = false
    }

    const readsBeforeRetry = reads.length
    assert.equal(
      find({ text: 'appendedneedle incrementalnote' }).hits[0]?.card,
      task.card,
    )
    assert.equal(
      reads.slice(readsBeforeRetry).find(entry => entry.path === task.native)?.position,
      throughCheckpoint,
      'retry preserves the committed native batch instead of ingesting it again',
    )
    assert.equal(
      reads[0]?.position,
      nativeSize,
    )
    assert.ok(
      reads.every(entry => entry.position !== null && entry.position >= nativeSize),
      'delta catch-up never reads an older byte',
    )
  },
)

test(
  'a replaced transcript resets only its own entries and reads only its admitted bytes',
  t => {
    const task = transcriptTask({ t })
    note({
      card: task.card,
      id: 'delta-note',
      text: 'incrementalnote',
    })
    assert.equal(
      find({ text: 'incrementalnote' }).hits[0]?.card,
      task.card,
    )
    const { hooks } = watchReads({
      t,
      task,
    })
    const replacement = `${task.native}.replacement`
    fs.writeFileSync(
      replacement,
      nativeLine({ text: 'replacementneedle' }) + nativeLine({ text: 'initialneedle' }),
    )
    fs.renameSync(
      replacement,
      task.native,
    )
    hooks.appendWhileReading = true
    assert.deepEqual(
      find({ text: 'replacementneedle futuremarker' }).hits,
      [],
      'a growing source is bounded to its admitted bytes',
    )
    assert.equal(
      find({ text: 'futuremarker' }).hits[0]?.card,
      task.card,
    )
    assert.equal(
      find({ text: 'replacementneedle' }).hits[0]?.card,
      task.card,
      'a replacement line at an archived numeric offset remains searchable',
    )
    assert.equal(
      find({ text: 'initialneedle' }).hits[0]?.snippets.length,
      1,
      'a reset retains the archive without indexing an unchanged native copy twice',
    )
    assert.equal(
      find({ text: 'ephemeralneedle' }).hits.length,
      0,
    )
    assert.equal(
      find({ text: 'incrementalnote' }).hits[0]?.card,
      task.card,
      'a native source reset preserves indexed events',
    )
  },
)

test(
  'a transcript truncated during catch-up resets on the next query',
  t => {
    const task = transcriptTask({ t })
    const { hooks } = watchReads({
      t,
      task,
    })
    fs.appendFileSync(
      task.native,
      nativeLine({ text: 'checkpoint '.repeat(CHECKPOINT_WORDS) }),
    )
    hooks.truncateAfterRead = true
    assert.deepEqual(
      find({ text: 'truncatedmarker*' }).hits,
      [],
      'a second source reset waits for the next query instead of restarting the current catch-up',
    )
    assert.equal(
      find({ text: 'truncatedmarker*' }).hits[0]?.card,
      task.card,
    )
  },
)

test(
  'another process advancing the transcript cursor mid-query does not duplicate its batch',
  t => {
    const task = transcriptTask({ t })
    const { hooks } = watchReads({
      t,
      task,
    })
    fs.appendFileSync(
      task.native,
      nativeLine({ text: 'overlapnative' }),
    )
    hooks.overlapNative = true
    assert.equal(
      find({ text: 'overlapnative' }).hits[0]?.snippets.length,
      1,
    )
  },
)

test(
  'an incompatible cache version rebuilds from durable sources and leaves the Hydra untouched',
  t => {
    const task = transcriptTask({ t })
    note({
      card: task.card,
      id: 'versioned-note',
      text: 'versionednote',
    })
    assert.equal(
      find({ text: 'versionednote' }).hits[0]?.card,
      task.card,
    )
    const stale = new DatabaseSync(searchPath({ hydraId: 'default' }))

    try {
      stale.exec("PRAGMA user_version=0; UPDATE docs SET text='obsoletecachedtext';")
    } finally {
      stale.close()
    }

    const before = storedHydra({ hydraId: 'default' })
    assert.equal(
      find({ text: 'versionednote' }).hits[0]?.card,
      task.card,
      'an incompatible cache version rebuilds stored text and postings from durable sources',
    )
    assert.equal(
      loadHydra({ hydraId: 'default' }).state.cards[task.card]?.title,
      'Delta task',
    )
    assert.equal(
      storedHydra({ hydraId: 'default' }),
      before,
    )
  },
)

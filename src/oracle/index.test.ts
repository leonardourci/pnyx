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
import { logPath, snapshotPath } from '#store/storage.ts'
import { search } from './search.ts'
import { searchPath } from './index.ts'

const EVENT_BATCH_WORDS = 6000
const PEER_SEARCH_TIMEOUT_MS = 10_000

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

// A task with one note and a cache that has caught up with it.
function notedTask({ t }: { t: TestContext }) {
  temporaryHome({
    t,
    prefix: 'oracle-deltas-',
  })
  assert.deepEqual(
    find({ text: 'emptyneedle' }).hits,
    [],
  )
  const card = 'index'
  note({
    card,
    id: 'initial-note',
    text: 'initialneedle',
  })
  assert.equal(
    find({ text: 'initialneedle' }).hits[0]?.card,
    card,
  )

  return {
    card,
    log: logPath({ dir: hydraDir({ hydraId: 'default' }) }),
  }
}

// Records every read of the event log, and lets a test fail it or advance the cursor from another process mid-read.
function watchReads({
  t,
  task,
}: {
  t: TestContext
  task: ReturnType<typeof notedTask>
}) {
  const descriptors = new Map<number, string>()
  const reads: {
    path: string
    position: number | null
    length: number
  }[] = []
  const hooks = {
    failEventRead: false,
    eventBatchStart: 0,
    failedEventPosition: 0,
    overlapEvents: false,
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
        '--input-type=module',
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
      const eventRead = path === task.log && length > 0
      const laterEventBatch = position !== null && position > hooks.eventBatchStart

      if (hooks.overlapEvents && eventRead) {
        hooks.overlapEvents = false
        peerSearch({ text: 'overlapevent' })
      }

      if (hooks.failEventRead && eventRead && laterEventBatch) {
        hooks.failedEventPosition = position
        throw new Error('Synthetic event batch read failure')
      }

      if (eventRead) {
        reads.push({
          path,
          position,
          length,
        })
      }

      return read(
        fd,
        buffer,
        offset,
        length,
        position,
      )
    },
  )
  syncBuiltinESMExports()

  return {
    reads,
    hooks,
  }
}

test(
  'Oracle removes the retired index and rebuilds its cache when the event log under it was replaced',
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

    for (const file of [
      logPath({ dir }),
      snapshotPath({ dir }),
    ]) {
      fs.rmSync(
        file,
        { force: true },
      )
    }

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
  'an unchanged query reads no historical bytes and needs no cache write lock',
  t => {
    const task = notedTask({ t })
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
      'an unchanged query reads no historical event bytes',
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
  'event batches commit with their cursor, so a retry after a failed read resumes after them',
  t => {
    const task = notedTask({ t })
    const {
      reads,
      hooks,
    } = watchReads({
      t,
      task,
    })
    hooks.eventBatchStart = fs.statSync(task.log).size

    for (const id of [
      'batch-one',
      'batch-two',
      'batch-three',
      'batch-four',
      'batch-five',
    ]) {
      note({
        card: task.card,
        id,
        text: `${id} ${'eventcheckpoint '.repeat(EVENT_BATCH_WORDS)}`,
      })
    }

    hooks.failEventRead = true

    try {
      assert.throws(
        () => find({ text: 'eventcheckpoint*' }),
        /Synthetic event batch read failure/,
      )
    } finally {
      hooks.failEventRead = false
    }

    const beforeEventRetry = reads.length
    assert.equal(
      find({ text: 'eventcheckpoint*' }).hits[0]?.card,
      task.card,
    )
    assert.ok(hooks.failedEventPosition > hooks.eventBatchStart)
    assert.equal(
      find({ text: 'batch-one' }).hits[0]?.card,
      task.card,
      'the first committed event batch remains searchable after a later read fails',
    )
    assert.equal(
      reads.slice(beforeEventRetry).find(entry => entry.path === task.log)?.position,
      hooks.failedEventPosition,
      'event retry resumes after committed batches',
    )
  },
)

test(
  'another process advancing a cursor mid-query does not duplicate its batch',
  t => {
    const task = notedTask({ t })
    const { hooks } = watchReads({
      t,
      task,
    })
    note({
      card: task.card,
      id: 'overlap-event',
      text: 'overlapevent',
    })
    hooks.overlapEvents = true
    assert.equal(
      find({ text: 'overlapevent' }).hits[0]?.snippets.length,
      1,
      'another process advancing the event cursor does not duplicate its batch',
    )
  },
)

test(
  'an incompatible cache version rebuilds from durable sources and leaves the log untouched',
  t => {
    const task = notedTask({ t })
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

    const before = fs.readFileSync(task.log)
    assert.equal(
      find({ text: 'versionednote' }).hits[0]?.card,
      task.card,
      'an incompatible cache version rebuilds stored text and postings from durable sources',
    )
    assert.equal(
      loadHydra({ hydraId: 'default' }).state.cards[task.card]?.title,
      'Noted task',
    )
    assert.deepEqual(
      fs.readFileSync(task.log),
      before,
    )
  },
)

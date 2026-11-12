import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { spawnSync } from 'node:child_process'
import { withWriter } from '#app/writer.ts'
import { loadHydra } from '#app/store.ts'
import { decidePush } from '#tasks/push.ts'
import { search } from './search.ts'
import { hydraDir } from '#app/home-migration.ts'
import { logPath, snapshotPath } from '#store/storage.ts'
import { searchPath } from './index.ts'

const CHECKPOINT_WORDS = 20_000
const TAIL_WORDS = 100_000
const EVENT_BATCH_WORDS = 6000
const PEER_SEARCH_TIMEOUT_MS = 10_000

const nativeLine = ({ text }: { text: string }) => `${JSON.stringify({
  type: 'user',
  message: {
    role: 'user',
    content: text,
  },
})}\n`

const noteEvent = ({
  id,
  text,
}: {
  id: string
  text: string
}) => withWriter({
  hydraId: 'default',
  fn: ({ writer }) => {
    const base = {
      v: 1 as const,
      cardId: 'task-noted',
      actor: 'fixture',
      at: '2026-11-12T10:00:00Z',
    }

    if (!writer.state.cards['task-noted']) {
      writer.append({
        event: {
          ...base,
          seq: writer.state.seq + 1,
          id: `create-${id}`,
          type: 'task.created',
          data: {
            key: 'noted',
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

test(
  'Oracle rebuilds its cache when the event log under it was replaced',
  t => {
    const root = fs.mkdtempSync(join(
      tmpdir(),
      'oracle-replaced-log-',
    ))
    const previous = process.env.PNYX_HOME
    process.env.PNYX_HOME = root
    t.after(() => {
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
    const find = ({ text }: { text: string }) => search({
      hydraId: 'default',
      query: {
        text,
        limit: 20,
      },
    }).total
    noteEvent({
      id: 'old-note',
      text: 'formerlogword',
    })
    noteEvent({
      id: 'old-second',
      text: 'formersecondword',
    })
    assert.equal(
      find({ text: 'formerlogword' }),
      1,
    )
    const dir = hydraDir({ hydraId: 'default' })

    for (const file of [
      logPath({ dir }),
      snapshotPath({ dir }),
    ]) {
      fs.rmSync(
        file,
        { force: true },
      )
    }

    noteEvent({
      id: 'new-note',
      text: 'replacedlogword',
    })
    assert.equal(
      find({ text: 'replacedlogword' }),
      1,
    )
    assert.equal(
      find({ text: 'formerlogword' }),
      0,
    )
  },
)

test(
  'Oracle persists deltas, reads only new bytes and resets only a replaced transcript',
  t => {
    const root = fs.mkdtempSync(join(
      tmpdir(),
      'oracle-deltas-',
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
    const native = join(
      root,
      'session.jsonl',
    )
    assert.deepEqual(
      search({
        hydraId: 'default',
        query: {
          text: 'emptyneedle',
          limit: 20,
        },
      }).hits,
      [],
    )
    fs.writeFileSync(
      native,
      nativeLine({text: 'initialneedle'}) + nativeLine({text: 'ephemeralneedle'}),
    )
    const created = withWriter({
      hydraId: 'default',
      fn: ({writer}) => {
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
        writer.append({event: decision.event})

        return {
          card: decision.event.cardId,
          log: join(
            writer.dir,
            'events.jsonl',
          ),
        }
      },
    })
    withWriter({
      hydraId: 'default',
      fn: ({ writer }) => writer.append({
        event: {
          v: 1,
          seq: writer.state.seq + 1,
          id: 'archived-original',
          actor: 'fixture',
          at: '2026-11-12T10:00:01Z',
          cardId: created.card,
          type: 'chat.message',
          data: {
            session: 'claude-code:delta',
            nativeId: '0:m0',
            role: 'user',
            text: 'initialneedle',
          },
        },
      }),
    })
    const find = ({ text }: { text: string }) => search({
      hydraId: 'default',
      query: {
        text,
        limit: 20,
      },
    })
    assert.equal(
      find({text: 'initialneedle'}).hits[0]?.card,
      created.card,
    )
    const captured = structuredClone(loadHydra({ hydraId: 'default' }).state)
    withWriter({
      hydraId: 'default',
      fn: ({ writer }) => {
        writer.append({
          event: {
            v: 1,
            seq: writer.state.seq + 1,
            id: 'earlier-record',
            actor: 'fixture',
            at: '2026-11-12T10:01:00Z',
            cardId: created.card,
            type: 'chat.message',
            data: {
              session: 'claude-code:delta',
              nativeId: 'earlier',
              role: 'user',
              text: 'zinnia',
            },
          },
        })
        assert.equal(
          find({ text: 'zinnia*' }).hits[0]?.card,
          created.card,
          'another reader caches the predecessor after the first query captures state',
        )
        writer.append({
          event: {
            v: 1,
            seq: writer.state.seq + 1,
            id: 'newer-record',
            actor: 'fixture',
            at: '2026-11-12T10:02:00Z',
            cardId: created.card,
            type: 'chat.message',
            data: {
              session: 'claude-code:delta',
              nativeId: 'newer',
              role: 'user',
              text: 'quartz',
              replaces: 'earlier-record',
            },
          },
        })
      },
    })
    assert.equal(
      search({
        hydraId: 'default',
        state: captured,
        query: {
          text: 'quartz*',
          limit: 20,
        },
      }).hits[0]?.card,
      created.card,
    )
    assert.equal(
      find({ text: 'zinnia*' }).total,
      0,
      'a correction beyond the captured state removes its older indexed entry',
    )
    const logSize = fs.statSync(created.log).size
    const nativeSize = fs.statSync(native).size
    const descriptors = new Map<number, string>()
    const reads: {
      path: string
      position: number | null
      length: number
    }[] = []
    let truncateAfterRead = false
    let appendWhileReading = false
    let failNativeRead = false
    let failFromPosition = 0
    let failEventRead = false
    let eventBatchStart = 0
    let failedEventPosition = 0
    let overlapEvents = false
    let overlapNative = false

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
        created.card,
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

        if (overlapNative && String(path) === native) {
          overlapNative = false
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

        const nativeRead = path === native && length > 0
        const pastFailure = position !== null && position >= failFromPosition

        const eventRead = path === created.log && length > 0
        const laterEventBatch = position !== null && position > eventBatchStart

        if (overlapEvents && eventRead) {
          overlapEvents = false
          peerSearch({ text: 'overlapevent' })
        }

        if (failEventRead && eventRead && laterEventBatch) {
          failedEventPosition = position
          throw new Error('Synthetic event batch read failure')
        }

        if (appendWhileReading && nativeRead) {
          appendWhileReading = false
          fs.appendFileSync(
            native,
            nativeLine({ text: 'futuremarker' }),
          )
        }

        if (failNativeRead && nativeRead && pastFailure) {
          throw new Error('Synthetic native read failure')
        }

        if ((path === created.log || path === native) && length > 0) {
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

        if (truncateAfterRead && nativeRead) {
          truncateAfterRead = false
          fs.writeFileSync(
            native,
            nativeLine({ text: 'truncatedmarker' }),
          )
        }

        return bytes
      },
    )
    syncBuiltinESMExports()
    assert.equal(
      find({text: 'initialneedle'}).hits[0]?.card,
      created.card,
    )
    assert.equal(
      reads.length,
      0,
      'an unchanged query reads no historical event or transcript bytes',
    )
    const locked = new DatabaseSync(searchPath({ hydraId: 'default' }))
    locked.exec('BEGIN IMMEDIATE')

    try {
      assert.equal(
        find({ text: 'initialneedle' }).hits[0]?.card,
        created.card,
        'an unchanged query needs no cache write lock',
      )
    } finally {
      locked.exec('ROLLBACK')
      locked.close()
    }

    const checkpoint = nativeLine({ text: 'checkpoint '.repeat(CHECKPOINT_WORDS) })
    const throughCheckpoint = nativeSize + Buffer.byteLength(checkpoint)
    fs.appendFileSync(
      native,
      checkpoint,
    )
    fs.appendFileSync(
      native,
      nativeLine({ text: `appendedneedle ${'tail '.repeat(TAIL_WORDS)}` }),
    )
    failFromPosition = throughCheckpoint
    withWriter({
      hydraId: 'default',
      fn: ({writer}) => writer.append({
        event: {
          v: 1,
          seq: writer.state.seq + 1,
          id: 'delta-note',
          type: 'card.noted',
          cardId: created.card,
          actor: 'fixture',
          at: '2026-11-12T10:01:00Z',
          data: {
            text: 'incrementalnote',
            kind: 'context',
            source: 'fixture',
          },
        },
      }),
    })
    failNativeRead = true

    try {
      assert.throws(
        () => find({text: 'appendedneedle incrementalnote'}),
        /Synthetic native read failure/,
      )
    } finally {
      failNativeRead = false
    }

    const readsBeforeRetry = reads.length
    assert.equal(
      find({text: 'appendedneedle incrementalnote'}).hits[0]?.card,
      created.card,
    )
    assert.equal(
      reads.slice(readsBeforeRetry).find(entry => entry.path === native)?.position,
      throughCheckpoint,
      'retry preserves the committed native batch instead of ingesting it again',
    )
    assert.ok(reads.some(entry => entry.path === created.log && entry.position === logSize))
    assert.ok(reads.some(entry => entry.path === native && entry.position === nativeSize))
    assert.ok(
      reads.every(entry => {
        const start = entry.path === native ? nativeSize : logSize

        return entry.position !== null && entry.position >= start
      }),
      'delta catch-up never reads an older byte',
    )
    fs.writeFileSync(
      join(
        root,
        'replacement.jsonl',
      ),
      nativeLine({text: 'replacementneedle'}) + nativeLine({text: 'initialneedle'}),
    )
    fs.renameSync(
      join(
        root,
        'replacement.jsonl',
      ),
      native,
    )
    reads.length = 0
    appendWhileReading = true
    assert.deepEqual(
      find({ text: 'replacementneedle futuremarker' }).hits,
      [],
      'a growing source is bounded to its admitted bytes',
    )
    assert.equal(
      find({ text: 'futuremarker' }).hits[0]?.card,
      created.card,
    )
    assert.equal(
      find({text: 'replacementneedle'}).hits[0]?.card,
      created.card,
      'a replacement line at an archived numeric offset remains searchable',
    )
    assert.equal(
      find({text: 'initialneedle'}).hits[0]?.snippets.length,
      1,
      'a reset retains the archive without indexing an unchanged native copy twice',
    )
    assert.equal(
      find({text: 'ephemeralneedle'}).hits.length,
      0,
    )
    assert.equal(
      find({text: 'incrementalnote'}).hits[0]?.card,
      created.card,
      'a native source reset preserves indexed events',
    )
    assert.ok(
      reads.every(entry => entry.path === native),
      'resetting one native source does not reread the event log',
    )
    fs.appendFileSync(
      native,
      nativeLine({ text: 'checkpoint '.repeat(CHECKPOINT_WORDS) }),
    )
    truncateAfterRead = true
    assert.deepEqual(
      find({ text: 'truncatedmarker*' }).hits,
      [],
      'a second source reset waits for the next query instead of restarting the current catch-up',
    )
    assert.equal(
      find({ text: 'truncatedmarker*' }).hits[0]?.card,
      created.card,
    )
    eventBatchStart = fs.statSync(created.log).size
    withWriter({
      hydraId: 'default',
      fn: ({ writer }) => {
        for (const id of [
          'batch-one',
          'batch-two',
          'batch-three',
          'batch-four',
          'batch-five',
        ]) {
          writer.append({
            event: {
              v: 1,
              seq: writer.state.seq + 1,
              id,
              type: 'card.noted',
              cardId: created.card,
              actor: 'fixture',
              at: '2026-11-12T10:03:00Z',
              data: {
                text: `${id} ${'eventcheckpoint '.repeat(EVENT_BATCH_WORDS)}`,
                kind: 'context',
                source: 'fixture',
              },
            },
          })
        }
      },
    })
    failEventRead = true

    try {
      assert.throws(
        () => find({ text: 'eventcheckpoint*' }),
        /Synthetic event batch read failure/,
      )
    } finally {
      failEventRead = false
    }

    const beforeEventRetry = reads.length
    assert.equal(
      find({ text: 'eventcheckpoint*' }).hits[0]?.card,
      created.card,
    )
    assert.ok(failedEventPosition > eventBatchStart)
    assert.equal(
      find({ text: 'batch-one' }).hits[0]?.card,
      created.card,
      'the first committed event batch remains searchable after a later read fails',
    )
    assert.equal(
      reads.slice(beforeEventRetry).find(entry => entry.path === created.log)?.position,
      failedEventPosition,
      'event retry resumes after committed batches',
    )
    withWriter({
      hydraId: 'default',
      fn: ({ writer }) => writer.append({
        event: {
          v: 1,
          seq: writer.state.seq + 1,
          id: 'overlap-event',
          type: 'card.noted',
          cardId: created.card,
          actor: 'fixture',
          at: '2026-11-12T10:04:00Z',
          data: {
            text: 'overlapevent',
            kind: 'context',
            source: 'fixture',
          },
        },
      }),
    })
    overlapEvents = true
    assert.equal(
      find({ text: 'overlapevent' }).hits[0]?.snippets.length,
      1,
      'another process advancing the event cursor does not duplicate its batch',
    )
    fs.appendFileSync(
      native,
      nativeLine({ text: 'overlapnative' }),
    )
    overlapNative = true
    assert.equal(
      find({ text: 'overlapnative' }).hits[0]?.snippets.length,
      1,
      'another process advancing the native cursor does not duplicate its batch',
    )
    const stale = new DatabaseSync(searchPath({ hydraId: 'default' }))

    try {
      stale.exec("PRAGMA user_version=0; UPDATE docs SET text='obsoletecachedtext';")
    } finally {
      stale.close()
    }

    assert.equal(
      find({ text: 'eventcheckpoint*' }).hits[0]?.card,
      created.card,
      'an incompatible cache version rebuilds stored text and postings from durable sources',
    )
    const before = fs.readFileSync(created.log)
    assert.equal(
      loadHydra({hydraId: 'default'}).state.cards[created.card]?.title,
      'Delta task',
    )
    assert.deepEqual(
      fs.readFileSync(created.log),
      before,
    )
  },
)

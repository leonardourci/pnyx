import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { withWriter } from '#app/writer.ts'
import { loadHydra } from '#app/store.ts'
import { decidePush } from '#tasks/push.ts'
import { search } from './search.ts'

const CHECKPOINT_WORDS = 20_000
const TAIL_WORDS = 100_000

const nativeLine = ({ text }: { text: string }) => `${JSON.stringify({
  type: 'user',
  message: {
    role: 'user',
    content: text,
  },
})}\n`

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
    fs.writeFileSync(
      native,
      nativeLine({text: 'initialneedle'}),
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
    const logSize = fs.statSync(created.log).size
    const nativeSize = fs.statSync(native).size
    const descriptors = new Map<number, string>()
    const reads: {
      path: string
      position: number | null
      length: number
    }[] = []
    let appendWhileReading = false
    let failNativeRead = false
    let failFromPosition = 0
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

        const nativeRead = path === native && length > 0
        const pastFailure = position !== null && position >= failFromPosition

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
    assert.equal(
      find({text: 'initialneedle'}).hits[0]?.card,
      created.card,
    )
    assert.equal(
      reads.length,
      0,
      'an unchanged query reads no historical event or transcript bytes',
    )
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
      nativeLine({text: 'replacementneedle'}),
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
    )
    assert.equal(
      find({text: 'initialneedle'}).hits.length,
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

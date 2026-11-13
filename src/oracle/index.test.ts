import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { withWriter } from '#app/writer.ts'
import { loadHydra } from '#app/store.ts'
import { hydraDir } from '#app/home-migration.ts'
import { query } from '#store/postgres.ts'
import { storedHydra } from '#test-harness/database.ts'
import { search } from './search.ts'
import { searchPath } from './index.ts'

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

  return { card }
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
  'an unchanged query needs no cache write lock',
  t => {
    const task = notedTask({ t })
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
  'an incompatible cache version rebuilds from durable sources and leaves the Hydra untouched',
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

    const before = storedHydra({ hydraId: 'default' })
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
      storedHydra({ hydraId: 'default' }),
      before,
    )
  },
)

// More events than one catch-up batch reads, so the index catches up in two.
const NOTED_EVENTS = 600
const SECOND_BATCH_SEQ = 550

const batchNote = ({ n }: { n: number }) => {
  if (n === 1) {
    return 'firstbatchword'
  }

  return n === NOTED_EVENTS ? 'lastbatchword' : `filler ${n}`
}

const cursorPosition = () => {
  const cache = new DatabaseSync(searchPath({ hydraId: 'default' }))

  try {
    return (cache.prepare('SELECT pos FROM cursors WHERE source = \'events\'').get() as { pos: number } | undefined)?.pos
  } finally {
    cache.close()
  }
}

test(
  'event batches commit with their cursor, so a retry after a failed read resumes after them',
  t => {
    temporaryHome({
      t,
      prefix: 'oracle-batches-',
    })
    const card = 'batched'
    withWriter({
      hydraId: 'default',
      fn: ({ writer }) => {
        const base = {
          v: 1 as const,
          cardId: card,
          actor: 'fixture',
          at: '2026-11-12T10:00:00Z',
        }
        writer.append({
          event: {
            ...base,
            seq: 1,
            id: 'create-batched',
            type: 'task.created',
            data: {
              key: card,
              title: 'Batched task',
            },
          },
        })

        for (let n = 1; n <= NOTED_EVENTS; n++) {
          writer.append({
            event: {
              ...base,
              seq: n + 1,
              id: `batch-note-${n}`,
              type: 'card.noted',
              data: {
                text: batchNote({ n }),
                kind: 'context',
                source: 'fixture',
              },
            },
          })
        }
      },
    })
    const where = 'hydra_id = $1 and seq = $2'
    const [[original]] = query({
      statements: [
        {
          text: `select data from events where ${where}`,
          values: [
            'default',
            SECOND_BATCH_SEQ,
          ],
        },
      ],
    }) as { data: unknown }[][]
    // A stored event the index cannot read fails the second batch.
    query({
      statements: [
        {
          text: `update events set data = (data::jsonb - 'data')::json where ${where}`,
          values: [
            'default',
            SECOND_BATCH_SEQ,
          ],
        },
      ],
    })
    assert.throws(
      () => find({ text: 'lastbatchword' }),
      TypeError,
    )
    assert.equal(
      cursorPosition(),
      500,
      'the first batch committed with its cursor',
    )

    query({
      statements: [
        {
          text: `update events set data = $3 where ${where}`,
          values: [
            'default',
            SECOND_BATCH_SEQ,
            JSON.stringify(original!.data),
          ],
        },
      ],
    })
    assert.equal(
      find({ text: 'lastbatchword' }).hits[0]?.card,
      card,
    )
    assert.equal(
      find({ text: 'firstbatchword' }).hits[0]?.snippets.length,
      1,
      'the retry resumed after the first batch instead of indexing it again',
    )
    assert.equal(
      cursorPosition(),
      601,
    )
  },
)

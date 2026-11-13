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

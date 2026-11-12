import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import type { Hit } from '#oracle/model.ts'
import { findCards, REFRESH_DELAY, SEARCH_DELAY, searchSchedule, type Search } from './card-oracle.ts'

const hit = ({ card }: { card: string }): Hit => ({
  card,
  title: card,
  match: 'lexical',
  snippets: [],
})

// A schedule whose searches answer only when the test says so, on mocked timers.
function fixture({ t }: { t: TestContext }) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const asked: Search[] = []
  const answers: {
    reply({ hits }: { hits: Hit[] }): void
    fail(): void
  }[] = []
  let cancelled = 0
  const shown: string[] = []
  const failed: string[] = []
  const schedule = searchSchedule({
    cancel: () => {
      cancelled += 1
    },
    find: ({ search }) => {
      asked.push(search)

      return new Promise((
        resolve,
        reject,
      ) => answers.push({
        reply: ({ hits }) => resolve(hits),
        fail: () => reject(new Error('The Hydra server is not answering')),
      }))
    },
    show: ({
      key,
      failed: failure,
    }) => (failure ? failed : shown).push(key),
  })
  // Answers resolve on microtasks; setImmediate is not mocked.
  const settle = () => new Promise(resolve => setImmediate(resolve))

  return {
    schedule,
    asked,
    answers,
    shown,
    failed,
    settle,
    cancellations: () => cancelled,
  }
}

test(
  'a stream of Hydra events never postpones a new search',
  async t => {
    const f = fixture({ t })
    f.schedule.query({
      search: {
        text: 'billing',
      },
    })

    for (let elapsed = 0; elapsed < 1000; elapsed += 100) {
      f.schedule.changed()
      t.mock.timers.tick(100)
    }

    assert.deepEqual(
      f.asked.map(search => search.text),
      ['billing'],
    )
    f.answers[0]!.reply({ hits: [hit({ card: 'task-1' })] })
    await f.settle()
    assert.deepEqual(
      f.shown,
      ['billing'],
    )
  },
)

test(
  'typing replaces the waiting query, and an older answer is dropped',
  async t => {
    const f = fixture({ t })
    f.schedule.query({
      search: {
        text: 'dep',
      },
    })
    t.mock.timers.tick(SEARCH_DELAY)
    f.schedule.query({
      search: {
        text: 'deplo',
      },
    })
    t.mock.timers.tick(SEARCH_DELAY / 2)
    f.schedule.query({
      search: {
        text: 'deploy',
      },
    })
    t.mock.timers.tick(SEARCH_DELAY)

    assert.deepEqual(
      f.asked.map(search => search.text),
      [
        'dep',
        'deploy',
      ],
    )
    f.answers[1]!.reply({ hits: [hit({ card: 'task-2' })] })
    f.answers[0]!.reply({ hits: [hit({ card: 'task-1' })] })
    await f.settle()
    assert.deepEqual(
      f.shown,
      ['deploy'],
    )
  },
)

test(
  'events refresh the answered query once per delay and never over a running search',
  async t => {
    const f = fixture({ t })
    f.schedule.query({
      search: {
        text: 'deploy',
      },
    })
    t.mock.timers.tick(SEARCH_DELAY)
    f.schedule.changed()
    t.mock.timers.tick(REFRESH_DELAY)
    assert.equal(
      f.asked.length,
      1,
      'the first search is still running, so the refresh waits',
    )
    f.answers[0]!.reply({ hits: [] })
    await f.settle()

    for (let elapsed = 0; elapsed < REFRESH_DELAY; elapsed += 100) {
      f.schedule.changed()
      t.mock.timers.tick(100)
    }

    assert.equal(
      f.asked.length,
      2,
    )
    assert.deepEqual(
      f.asked[1],
      {
        text: 'deploy',
      },
    )
  },
)

test(
  'a failed search still answers its query, with no hits, while a failed refresh keeps the results shown',
  async t => {
    const f = fixture({ t })
    f.schedule.query({
      search: {
        text: 'deploy',
      },
    })
    t.mock.timers.tick(SEARCH_DELAY)
    f.answers[0]!.fail()
    await f.settle()
    assert.deepEqual(
      f.failed,
      ['deploy'],
      'the query is answered, so Enter and the arrows stop waiting for it',
    )

    f.schedule.query({
      search: {
        text: 'billing',
      },
    })
    t.mock.timers.tick(SEARCH_DELAY)
    f.answers[1]!.reply({ hits: [hit({ card: 'task-1' })] })
    await f.settle()
    f.schedule.changed()
    t.mock.timers.tick(REFRESH_DELAY)
    f.answers[2]!.fail()
    await f.settle()
    assert.deepEqual(
      f.shown,
      ['billing'],
    )
    assert.deepEqual(
      f.failed,
      ['deploy'],
      'the refresh of an answered query failed, so its results stay',
    )
  },
)

test(
  'a card search asks the Hydra server for every workspace, live cards included',
  async () => {
    const sent: {
      name: string
      args: string[]
    }[] = []
    const hits = await findCards({
      command: async ({
        name,
        args,
      }) => {
        sent.push({
          name,
          args,
        })

        return { hits: [hit({ card: 'task-1' })] }
      },
      query: 'deploy',
      live: true,
    })

    assert.deepEqual(
      sent,
      [
        {
          name: 'oracle',
          args: [
            'deploy',
            '',
            'hydra',
          ],
        },
      ],
    )
    assert.deepEqual(
      hits,
      [hit({ card: 'task-1' })],
    )
  },
)

test(
  'clearing or closing Oracle cancels its scan and older answers do not restart a pending query',
  async t => {
    const f = fixture({ t })
    f.schedule.query({ search: { text: 'first' } })
    t.mock.timers.tick(SEARCH_DELAY)
    f.schedule.query({ search: { text: 'second' } })
    t.mock.timers.tick(SEARCH_DELAY)
    f.answers[0]!.fail()
    await f.settle()
    f.schedule.changed()
    t.mock.timers.tick(REFRESH_DELAY)
    assert.deepEqual(
      f.asked.map(search => search.text),
      [
        'first',
        'second',
      ],
    )
    f.schedule.query({ search: null })
    assert.equal(
      f.cancellations(),
      1,
    )
    f.answers[1]!.fail()
    await f.settle()
    f.schedule.query({ search: { text: 'third' } })
    t.mock.timers.tick(SEARCH_DELAY)
    f.schedule.stop()
    assert.equal(
      f.cancellations(),
      2,
    )
    f.answers[2]!.fail()
    await f.settle()
    assert.deepEqual(
      f.shown,
      [],
    )
  },
)

import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import type { Hit } from '#oracle/index.ts'
import { REFRESH_DELAY, SEARCH_DELAY, searchSchedule, type Search } from './card-oracle.ts'

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
  const answers: { reply({ hits }: { hits: Hit[] }): void }[] = []
  const shown: string[] = []
  const schedule = searchSchedule({
    find: ({ search }) => {
      asked.push(search)

      return new Promise(resolve => answers.push({ reply: ({ hits }) => resolve(hits) }))
    },
    show: ({ key }) => shown.push(key),
  })
  // Answers resolve on microtasks; setImmediate is not mocked.
  const settle = () => new Promise(resolve => setImmediate(resolve))

  return {
    schedule,
    asked,
    answers,
    shown,
    settle,
  }
}

test(
  'a stream of Hydra events never postpones a new search',
  async t => {
    const f = fixture({ t })
    f.schedule.query({
      search: {
        text: 'billing',
        workspace: '',
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
      ['billing\n'],
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
        workspace: '',
      },
    })
    t.mock.timers.tick(SEARCH_DELAY)
    f.schedule.query({
      search: {
        text: 'deplo',
        workspace: '',
      },
    })
    t.mock.timers.tick(SEARCH_DELAY / 2)
    f.schedule.query({
      search: {
        text: 'deploy',
        workspace: '',
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
      ['deploy\n'],
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
        workspace: 'ops',
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
        workspace: 'ops',
      },
    )
  },
)

import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { INDEX_DELAY_MS, indexRuns } from './index-runs.ts'

// Catch-ups that finish only when the test says so, on mocked timers.
function fixture({ t }: { t: TestContext }) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const finishes: { finish(): void }[] = []
  const start = () => new Promise<void>(resolve => finishes.push({ finish: () => resolve() }))
  const runs = indexRuns({ start })
  // Runs settle on microtasks; setImmediate is not mocked.
  const settle = () => new Promise(resolve => setImmediate(resolve))

  return {
    runs,
    finishes,
    settle,
  }
}

test(
  'a burst of Hydra events starts one catch-up',
  async t => {
    const f = fixture({ t })

    for (let elapsed = 0; elapsed < INDEX_DELAY_MS; elapsed += 100) {
      f.runs.changed()
      t.mock.timers.tick(100)
    }

    await f.settle()
    assert.equal(
      f.finishes.length,
      1,
    )
  },
)

test(
  'events during a catch-up fold into exactly one more run after it',
  async t => {
    const f = fixture({ t })
    f.runs.changed()
    t.mock.timers.tick(INDEX_DELAY_MS)

    for (let elapsed = 0; elapsed < 5 * INDEX_DELAY_MS; elapsed += 100) {
      f.runs.changed()
      t.mock.timers.tick(100)
    }

    assert.equal(
      f.finishes.length,
      1,
      'a second catch-up never starts while the first runs',
    )
    f.finishes[0]!.finish()
    await f.settle()
    assert.equal(
      f.finishes.length,
      2,
    )
    f.finishes[1]!.finish()
    await f.settle()
    t.mock.timers.tick(5 * INDEX_DELAY_MS)
    await f.settle()
    assert.equal(
      f.finishes.length,
      2,
    )
  },
)

test(
  'a query starts a catch-up at once, or waits for one that starts after the running one',
  async t => {
    const f = fixture({ t })
    let answered = false
    const first = (async () => {
      await f.runs.ready()
      answered = true
    })()
    await f.settle()
    assert.equal(
      f.finishes.length,
      1,
      'ready starts a catch-up without waiting for the delay',
    )
    f.finishes[0]!.finish()
    await first
    assert.equal(
      answered,
      true,
    )

    f.runs.changed()
    t.mock.timers.tick(INDEX_DELAY_MS)
    answered = false
    const second = (async () => {
      await f.runs.ready()
      answered = true
    })()
    f.finishes[1]!.finish()
    await f.settle()
    assert.equal(
      f.finishes.length,
      3,
      'the running catch-up may predate the change, so one more starts',
    )
    assert.equal(
      answered,
      false,
    )
    f.finishes[2]!.finish()
    await second
    assert.equal(
      answered,
      true,
    )
  },
)

import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { INDEX_DELAY_MS, indexRuns } from './index-runs.ts'

// Catch-ups that finish only when the test says so, on mocked timers.
function fixture({ t }: { t: TestContext }) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const finishes: {
    finish(): void
    fail({ error }: { error: string }): void
  }[] = []
  const start = () => new Promise<string | undefined>(resolve => finishes.push({
    finish: () => resolve(undefined),
    fail: ({ error }) => resolve(error),
  }))
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
  'a query waits for changes newer than an in-flight catch-up and gets only its own failure',
  async t => {
    const f = fixture({ t })
    const first = f.runs.ready()
    f.finishes[0]!.finish()
    assert.equal(
      await first,
      undefined,
    )

    f.runs.changed()
    t.mock.timers.tick(INDEX_DELAY_MS)
    let answered = false
    const pending = (async () => {
      const error = await f.runs.ready()
      answered = true

      return error
    })()
    f.finishes[1]!.fail({ error: 'an older write failed' })
    await f.settle()
    assert.equal(
      answered,
      false,
      'the running catch-up predates this query',
    )
    f.finishes[2]!.fail({ error: 'the current write failed' })
    assert.equal(
      await pending,
      'the current write failed',
    )

    const recovered = f.runs.ready()
    f.finishes[3]!.finish()
    assert.equal(
      await recovered,
      undefined,
    )
    f.runs.stop()
  },
)

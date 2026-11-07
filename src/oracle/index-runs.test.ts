import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { BACKGROUND_CATCHUPS, INDEX_DELAY_MS, indexRuns } from './index-runs.ts'

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

test(
  'background catch-ups across Hydras run a few at a time, a stopped Hydra’s waiting one never starts, and a query does not wait in line',
  async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const started: string[] = []
    const finishes = new Map<string, () => void>()
    const hydra = ({ id }: { id: string }) => indexRuns({
      start: () => new Promise<undefined>(resolve => {
        started.push(id)
        finishes.set(
          id,
          () => resolve(undefined),
        )
      }),
    })
    const settle = () => new Promise(resolve => setImmediate(resolve))
    const ids = Array.from(
      { length: BACKGROUND_CATCHUPS + 2 },
      (
        _,
        index,
      ) => `hydra-${index}`,
    )
    const runs = ids.map(id => hydra({ id }))
    runs.forEach(run => run.changed())
    t.mock.timers.tick(INDEX_DELAY_MS)
    assert.deepEqual(
      started,
      ids.slice(
        0,
        BACKGROUND_CATCHUPS,
      ),
    )

    runs.at(-2)!.stop()
    const query = hydra({ id: 'query' }).ready()
    assert.equal(
      started.at(-1),
      'query',
    )
    finishes.get('query')!()
    await query

    finishes.get('hydra-0')!()
    await settle()
    assert.equal(
      started.at(-1),
      ids.at(-1),
    )
    assert.equal(
      started.includes(ids.at(-2)!),
      false,
    )
    ids.forEach(id => finishes.get(id)?.())
    await settle()
  },
)

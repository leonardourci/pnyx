import assert from 'node:assert/strict'
import { test } from 'node:test'
import { withWriter } from '#app/writer.ts'
import { searchInBackground } from './search-background.ts'
import { observeSearchWorkers } from '#oracle/fixtures/search-workers.ts'

const query = {
  text: 'saffron',
  limit: 20,
}

test(
  'Oracle runs one scan per Hydra and cancels queued and active requests',
  async t => {
    const hydraId = 'default'
    const folder = withWriter({
      hydraId,
      fn: ({ writer }) => writer.dir,
    })
    let cancel: AbortController | undefined
    const observer = observeSearchWorkers({
      hydraId,
      folder,
      started: ({ worker }) => {
        worker.once(
          'online',
          () => cancel?.abort(),
        )
      },
    })
    t.after(() => observer.close())
    const gate = observer.gateNext()
    const first = searchInBackground({
      hydraId,
      query,
    })
    await gate.ready()
    const cancelled = new AbortController()
    const queued = searchInBackground({
      hydraId,
      query,
      signal: cancelled.signal,
    })
    const refused = assert.rejects(
      queued,
      { code: 'CANCELLED' },
    )
    const next = searchInBackground({
      hydraId,
      query,
    })
    cancelled.abort()
    gate.release()
    await Promise.all([
      first,
      refused,
      next,
    ])
    assert.equal(
      observer.observed.maximum,
      1,
      'only one native search worker runs at a time',
    )
    assert.equal(
      observer.observed.created,
      2,
      'the cancelled queued request opens no worker',
    )
    cancel = new AbortController()
    await assert.rejects(
      searchInBackground({
        hydraId,
        query,
        signal: cancel.signal,
      }),
      { code: 'CANCELLED' },
    )
    assert.deepEqual(
      observer.observed.exits,
      [
        0,
        0,
        1,
      ],
      'cancellation terminates the active worker',
    )
    cancel = undefined
    assert.equal(
      (await searchInBackground({
        hydraId,
        query,
      })).hits.length,
      0,
    )
  },
)

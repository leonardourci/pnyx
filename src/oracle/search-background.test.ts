import assert from 'node:assert/strict'
import { syncBuiltinESMExports } from 'node:module'
import { test } from 'node:test'
import workerThreads, { Worker } from 'node:worker_threads'
import { withWriter } from '#app/writer.ts'
import { searchInBackground } from './search-background.ts'

const query = {
  text: 'saffron',
  limit: 20,
}

test(
  'Oracle runs one scan per Hydra and cancels queued and active requests',
  async t => {
    const hydraId = 'default'
    withWriter({
      hydraId,
      fn: () => undefined,
    })
    let stopped = () => {}
    const exited = new Promise<void>(resolve => {
      stopped = resolve
    })
    let constructed = 0
    const exits: number[] = []
    let release = () => {}
    let cancel: AbortController | undefined
    const OriginalWorker = Worker

    class ObservedWorker extends OriginalWorker {
      // eslint-disable-next-line pnyx/object-params -- Node Worker constructor contract.
      constructor(...args: ConstructorParameters<typeof Worker>) {
        super(...args)
        constructed += 1
        this.on(
          'exit',
          (code: number) => {
            exits.push(code)
          },
        )
        this.once(
          'online',
          () => cancel?.abort(),
        )
      }

      // eslint-disable-next-line pnyx/object-params -- Node EventEmitter listener contract.
      override once(...parameters: Parameters<Worker['once']>): this {
        const [
          event,
          listener,
        ] = parameters

        if (event === 'exit' && constructed === 1) {
          return super.once(
            event,
            (...args: unknown[]) => {
              release = () => {
                listener(...args)
                release = () => {}
              }

              stopped()
            },
          )
        }

        return super.once(
          event,
          listener,
        )
      }
    }

    workerThreads.Worker = ObservedWorker
    syncBuiltinESMExports()
    t.after(() => {
      release()
      workerThreads.Worker = OriginalWorker
      syncBuiltinESMExports()
    })
    const first = searchInBackground({
      hydraId,
      query,
    })
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
    await exited
    assert.equal(
      constructed,
      1,
      'a second scan cannot start before the first worker exits',
    )
    release()
    await Promise.all([
      first,
      refused,
      next,
    ])
    assert.equal(
      constructed,
      2,
      'the cancelled queued search never opens a worker',
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
      exits,
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

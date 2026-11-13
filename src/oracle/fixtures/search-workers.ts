import { existsSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import workerThreads, { Worker, setEnvironmentData } from 'node:worker_threads'
import { settle } from '#test-harness/child-fixture.ts'

const PRELOAD = new URL(
  './search-gate.ts',
  import.meta.url,
).href

export function observeSearchWorkers({
  hydraId,
  folder,
  started,
}: {
  hydraId: string
  folder: string
  started?({ worker }: { worker: Worker }): void
}) {
  const OriginalWorker = Worker
  const workers = new Set<Worker>()
  const gates: {
    buffer: SharedArrayBuffer
    ready: string
  }[] = []
  const waiting: typeof gates = []
  const observed = {
    created: 0,
    maximum: 0,
    exits: [] as number[],
  }

  const release = ({ buffer }: { buffer: SharedArrayBuffer }) => {
    Atomics.store(
      new Int32Array(buffer),
      0,
      1,
    )
    Atomics.notify(
      new Int32Array(buffer),
      0,
    )
  }

  class ObservedWorker extends OriginalWorker {
    // eslint-disable-next-line pnyx/object-params -- Node owns the Worker constructor signature.
    constructor(...parameters: ConstructorParameters<typeof Worker>) {
      const [
        filename,
        options,
      ] = parameters
      const input: unknown = options?.workerData
      const search = typeof input === 'object' && input !== null && 'query' in input
        && 'hydraId' in input && input.hydraId === hydraId
      let workerOptions = options

      if (search) {
        setEnvironmentData(
          PRELOAD,
          waiting.shift(),
        )
        workerOptions = {
          ...options,
          execArgv: [
            ...(options?.execArgv ?? []),
            '--import',
            PRELOAD,
          ],
        }
      }

      super(
        filename,
        workerOptions,
      )

      if (search) {
        setEnvironmentData(
          PRELOAD,
          undefined,
        )
        workers.add(this)
        observed.created += 1
        observed.maximum = Math.max(
          observed.maximum,
          workers.size,
        )
        this.on(
          'exit',
          (code: number) => {
            workers.delete(this)
            observed.exits.push(code)
          },
        )
        started?.({ worker: this })
      }
    }
  }

  workerThreads.Worker = ObservedWorker
  syncBuiltinESMExports()

  return {
    observed,
    gateNext() {
      const gate = {
        buffer: new SharedArrayBuffer(4),
        ready: join(
          folder,
          `search-ready-${gates.length}`,
        ),
      }
      gates.push(gate)
      waiting.push(gate)

      return {
        release: () => release(gate),
        async ready() {
          try {
            await settle({
              what: 'Oracle worker to reach its fixture gate',
              check: () => existsSync(gate.ready),
            })
          } catch (error) {
            throw new Error(
              `Oracle gate not reached: ${JSON.stringify(observed)}`,
              { cause: error },
            )
          }
        },
      }
    },
    async close() {
      gates.forEach(release)

      try {
        await Promise.all([...workers].map(worker => worker.terminate()))
      } finally {
        workerThreads.Worker = OriginalWorker
        syncBuiltinESMExports()
        setEnvironmentData(
          PRELOAD,
          undefined,
        )
      }
    },
  }
}

import { log } from '#app/diagnostics.ts'
import type { UsageReading } from './provider.ts'
import { isMainThread, parentPort, Worker } from 'node:worker_threads'
import { spendFor, sessionReadings, type SpendInputs, type TaskSpend } from './task-spend.ts'

if (!isMainThread) {
  parentPort!.on(
    'message',
    (inputs: SpendInputs) => parentPort!.postMessage({
      spend: spendFor({ inputs }),
      readings: sessionReadings({ inputs }),
    }),
  )
}

type SpendResult = {
  spend: Record<string, TaskSpend>
  readings: Record<string, UsageReading>
}

// A thread costs tens of megabytes, so an idle Hydra's counter lets it go; the next count starts another.
const IDLE_MS = 30_000

// Counting reads transcripts, so it runs in a worker thread, off the server's event loop.
// One count runs at a time; asking during it runs one more count, on the inputs of that moment.
export function spendCounter({
  inputs,
  onSpend,
}: {
  inputs(): SpendInputs
  onSpend({
    spend,
    readings,
  }: SpendResult): void
}) {
  let worker: Worker | undefined
  let busy = false
  let again = false
  let closed = false
  let idle: ReturnType<typeof setTimeout> | undefined

  const retire = () => {
    const thread = worker
    worker = undefined
    thread?.terminate().catch((error: Error) => {
      log({
        level: 'error',
        operation: 'spend.count',
        error,
      })
    })
  }

  const finish = () => {
    busy = false

    if (again) {
      again = false
      count()

      return
    }

    idle = setTimeout(
      retire,
      IDLE_MS,
    )
    idle.unref()
  }

  const start = () => {
    const thread = new Worker(new URL(import.meta.url))
    thread.unref()
    thread.on(
      'message',
      (result: SpendResult) => {
        if (!closed) {
          onSpend(result)
        }

        finish()
      },
    )
    // A crashed count starts a fresh worker next time.
    thread.on(
      'error',
      (error: Error) => {
        log({
          level: 'error',
          operation: 'spend.count',
          error,
        })

        if (worker === thread) {
          worker = undefined
        }

        finish()
      },
    )

    return thread
  }

  function count() {
    clearTimeout(idle)

    if (closed) {
      return
    }

    if (busy) {
      again = true

      return
    }

    busy = true

    try {
      worker ??= start()
      worker.postMessage(inputs())
    } catch (error) {
      log({
        level: 'error',
        operation: 'spend.count',
        error,
      })
      busy = false
    }
  }

  return {
    count,
    close: async () => {
      closed = true
      clearTimeout(idle)
      await worker?.terminate()
      worker = undefined
    },
  }
}

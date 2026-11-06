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

  const finish = () => {
    busy = false

    if (again) {
      again = false
      count()
    }
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
        console.error(`pnyx-axi spend: ${error.message}`)

        if (worker === thread) {
          worker = undefined
        }

        finish()
      },
    )

    return thread
  }

  function count() {
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
      console.error(`pnyx-axi spend: ${(error as Error).message}`)
      busy = false
    }
  }

  return {
    count,
    close: async () => {
      closed = true
      await worker?.terminate()
      worker = undefined
    },
  }
}

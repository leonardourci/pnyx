import { Worker } from 'node:worker_threads'
import type { writeSnapshot } from './snapshot.ts'
import { basename } from 'node:path'
import { log } from './diagnostics.ts'

// Its own entry file, so a worker thread of another feature that imports this module does not run a snapshot.
const WORKER_ENTRY = new URL(
  import.meta.url.endsWith('.ts') ? './snapshot-worker.ts' : './snapshot-worker.js',
  import.meta.url,
)

let snapshotRun: Promise<void> | undefined

export async function snapshotInBackground({ dir }: { dir: string }): Promise<void> {
  const previous = snapshotRun

  const next = async () => {
    try {
      await previous
    } catch {
      // The previous caller receives its failure; later Hydras still save their caches.
    }

    await writeInBackground({ dir })
  }

  const pending = next()
  snapshotRun = pending

  try {
    await pending
  } finally {
    if (snapshotRun === pending) {
      snapshotRun = undefined
    }
  }
}

function writeInBackground({ dir }: { dir: string }): Promise<void> {
  return new Promise((
    resolve,
    reject,
  ) => {
    const worker = new Worker(
      WORKER_ENTRY,
      { workerData: dir },
    )
    let failure: Error | undefined
    worker.once(
      'message',
      (result: ReturnType<typeof writeSnapshot>) => log({
        operation: 'snapshot.write',
        hydraId: basename(dir),
        ...result,
      }),
    )
    worker.once(
      'error',
      (error: Error) => {
        failure = error
      },
    )
    worker.once(
      'exit',
      code => {
        if (failure) {
          reject(failure)

          return
        }

        if (code !== 0) {
          reject(new Error(`Snapshot worker exited with code ${code}`))

          return
        }

        resolve()
      },
    )
  })
}

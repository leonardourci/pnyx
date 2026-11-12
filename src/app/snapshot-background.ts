import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads'
import { loadHydraDirectory } from './store.ts'
import { writeSnapshot } from './snapshot.ts'
import { basename } from 'node:path'
import { log } from './diagnostics.ts'

if (!isMainThread) {
  if (typeof workerData !== 'string') {
    throw new Error('Snapshot worker requires a Hydra directory')
  }

  const loaded = loadHydraDirectory({ dir: workerData })

  if (loaded.tornBytes > 0) {
    throw new Error('Cannot snapshot a torn event log')
  }

  parentPort?.postMessage(writeSnapshot(loaded))
}

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
      new URL(import.meta.url),
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

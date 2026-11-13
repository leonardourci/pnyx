import { parentPort, workerData } from 'node:worker_threads'
import { loadHydraDirectory } from './store.ts'
import { writeSnapshot } from './snapshot.ts'

if (typeof workerData !== 'string' || !parentPort) {
  throw new Error('Snapshot worker requires a worker thread and a Hydra directory')
}

const loaded = loadHydraDirectory({ dir: workerData })

if (loaded.tornBytes > 0) {
  throw new Error('Cannot snapshot a torn event log')
}

parentPort.postMessage(writeSnapshot(loaded))

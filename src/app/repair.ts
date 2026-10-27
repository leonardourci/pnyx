import {
  readFileSync,
} from 'node:fs'
import { EVENT_VERSION } from '../core/model.ts'
import { emptyHydra, replay } from '../core/reducer.ts'
import { readLog } from './event-log.ts'
import type { LogRead, RepairMarker } from './event-log.ts'
import { hydraDir } from './home-migration.ts'
import { privateDir, logPath, writeDurably, writeSnapshot, acquireLock, requireHydra } from '../store/hydra-store.ts'

export interface Repair {
  tornBytes: number
  preserved?: string
  seq: number
}

// Copies a torn tail to a side file, then closes it with a newline and a repair
// marker so readers skip that line; the log itself is never cut. A torn tail was
// never acknowledged as written, so no accepted event is lost.
// ponytail: a crash while appending the marker leaves a corrupt interior line; inspect it by hand.
export function repairHydra({ hydraId }: { hydraId: string }): Repair {
  requireHydra({ hydraId })
  const dir = hydraDir({ hydraId })
  privateDir({ dir })
  const release = acquireLock({ dir })

  try {
    let log = readLog({ dir }) as LogRead
    const tornBytes = log.size - log.end
    let preserved: string | undefined

    if (tornBytes > 0) {
      preserved = `${logPath({ dir })}.torn-${log.end}`
      writeDurably({
        path: preserved,
        data: readFileSync(logPath({ dir })).subarray(log.end),
        flag: 'w',
      })
      const marker: RepairMarker = {
        v: EVENT_VERSION,
        type: 'log.repaired',
        at: new Date().toISOString(),
        data: {
          offset: log.end,
          length: tornBytes,
        },
      }
      writeDurably({
        path: logPath({ dir }),
        data: `\n${JSON.stringify(marker)}\n`,
        flag: 'a',
      })
      log = readLog({ dir }) as LogRead
    }

    const state = replay({
      state: emptyHydra(),
      events: log.events,
    })
    writeSnapshot({
      dir,
      state,
      offset: log.end,
    })

    return {
      tornBytes,
      ...(preserved ? { preserved } : {}),
      seq: state.seq,
    }
  } finally {
    release()
  }
}

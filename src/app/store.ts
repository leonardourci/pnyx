import { HydraError, type HydraState } from '../core/model.ts'
import { hydraDir, DEFAULT_HYDRA } from './home-migration.ts'
import { readSnapshot } from './snapshot.ts'
import { readLog, type LogRead } from './event-log.ts'
import { emptyHydra, replay } from '../core/reducer.ts'
import { existsSync } from 'node:fs'
import { logPath } from '../store/hydra-store.ts'

export interface HydraSnapshot {
  dir: string
  state: HydraState
  offset: number
  tornBytes: number
}

export function loadHydra({ hydraId }: { hydraId: string }): HydraSnapshot {
  const dir = hydraDir({ hydraId })
  const snap = readSnapshot({ dir })
  let log = snap ? readLog({
    dir,
    from: snap.offset,
  }) : null
  let start = snap?.state ?? emptyHydra()

  if (!log || (snap && log.events.length > 0 && log.events[0]!.seq !== snap.state.seq + 1)) {
    log = readLog({ dir }) as LogRead
    start = emptyHydra()
  }

  return {
    dir,
    state: replay({
      state: start,
      events: log.events,
    }),
    offset: log.end,
    tornBytes: log.size - log.end,
  }
}

// A Hydra exists once its log does; a bare folder, such as one a config write made, does not count.
export function requireHydra({ hydraId }: { hydraId: string }): void {
  if (hydraId !== DEFAULT_HYDRA && !existsSync(logPath({ dir: hydraDir({ hydraId }) }))) {
    throw new HydraError({
      message: `unknown Hydra: ${hydraId}`,
      code: 'NOT_FOUND',
      help: ['Run `pnyx-axi hydra list` for the Hydras, or `pnyx-axi hydra create <id>` to add one'],
    })
  }
}

export function loadTail({ hydraId }: { hydraId: string }): HydraSnapshot {
  const loaded = loadHydra({ hydraId })

  if (loaded.tornBytes > 0) {
    throw new HydraError({
      message: `events.jsonl ends with ${loaded.tornBytes} bytes of a torn append`,
      code: 'TORN_TAIL',
      help: ['Run `pnyx-axi repair` to set them aside and continue'],
    })
  }

  return loaded
}

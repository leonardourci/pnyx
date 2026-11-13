import type { HydraState } from './model.ts'
import { HydraError } from '#store/errors.ts'
import { hydraDir, DEFAULT_HYDRA } from './home-migration.ts'
import { readSnapshot } from './snapshot.ts'
import { readLog, type LogRead } from './event-log.ts'
import { emptyHydra, replayOwned } from './reducer.ts'
import { existsSync } from 'node:fs'
import { logPath } from '#store/storage.ts'

export interface HydraSnapshot {
  dir: string
  state: HydraState
  offset: number
  tornBytes: number
}

// A Hydra the server holds: its state lives in memory, and every change is appended to its log before it applies.
export type Held = {
  dir: string
  state: HydraState
  offset: number
  // Called after each write, so the server pushes the change in the same step.
  changed(): void
}

const held = new Map<string, Held>()

export const heldHydra = ({ hydraId }: { hydraId: string }) => held.get(hydraId)

// The server keeps the Hydra in memory from here until the returned release; the server saves its snapshot when it stops.
export function holdHydra({
  hydraId,
  changed,
}: {
  hydraId: string
  changed(): void
}): () => void {
  const loaded = loadTail({ hydraId })
  const entry: Held = {
    dir: loaded.dir,
    state: loaded.state,
    offset: loaded.offset,
    changed,
  }
  held.set(
    hydraId,
    entry,
  )

  return () => {
    if (held.get(hydraId) === entry) {
      held.delete(hydraId)
    }
  }
}

// Reads return the live state of a held Hydra; callers must treat it as read-only.
export function loadHydra({
  hydraId,
  migrate = true,
}: {
  hydraId: string
  migrate?: boolean
}): HydraSnapshot {
  const live = held.get(hydraId)

  if (live) {
    return {
      dir: live.dir,
      state: live.state,
      offset: live.offset,
      tornBytes: 0,
    }
  }

  const dir = hydraDir({
    hydraId,
    migrate,
  })

  return loadHydraDirectory({ dir })
}

export function loadHydraDirectory({ dir }: { dir: string }): HydraSnapshot {
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
    state: replayOwned({
      state: start,
      events: log.events,
    }),
    offset: log.end,
    tornBytes: log.size - log.end,
  }
}

// A Hydra exists once its log does; a bare folder, such as one a config write made, does not count.
export function requireHydra({
  hydraId,
  migrate = true,
}: {
  hydraId: string
  migrate?: boolean
}): void {
  if (hydraId !== DEFAULT_HYDRA && !existsSync(logPath({
    dir: hydraDir({
      hydraId,
      migrate,
    }),
  }))) {
    throw new HydraError({
      message: `unknown Hydra: ${hydraId}`,
      code: 'NOT_FOUND',
      help: ['Run `pnyx-axi hydra list` for the Hydras, or `pnyx-axi hydra create <id>` to add one'],
    })
  }
}

export function loadTail({
  hydraId,
  migrate = true,
}: {
  hydraId: string
  migrate?: boolean
}): HydraSnapshot {
  const loaded = loadHydra({
    hydraId,
    migrate,
  })

  if (loaded.tornBytes > 0) {
    throw new HydraError({
      message: `events.jsonl ends with ${loaded.tornBytes} bytes of a torn append`,
      code: 'TORN_TAIL',
      help: ['Run `pnyx-axi repair` to set them aside and continue'],
    })
  }

  return loaded
}

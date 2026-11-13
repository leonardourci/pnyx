import type { HydraState } from './model.ts'
import { HydraError } from '#store/errors.ts'
import { homeScoped, query, storable } from '#store/postgres.ts'
import { hydraDir, DEFAULT_HYDRA } from './home-migration.ts'
import { emptyHydra } from './reducer.ts'
import { emptySaved, loadStatements, stateFromRows, type SavedRows } from './rows.ts'
import { readLog } from './legacy-log.ts'
import { importHydra } from './import.ts'
import { log } from './diagnostics.ts'
import { logPath } from '#store/storage.ts'
import { existsSync } from 'node:fs'

export interface HydraSnapshot {
  dir: string
  state: HydraState
}

// A Hydra this process keeps in memory: its state as of its last committed write, and the rows that write left.
export type Held = {
  dir: string
  state: HydraState
  saved: SavedRows
  // Set when a failed write could not read the Hydra back; the next read or write tries again.
  stale?: boolean
  // Called after each committed write, and after a failed one is read back, so the server shows the change.
  changed(): void
}

// The server holds each Hydra it serves; any other process keeps what it loaded, checked against the Hydra's seq.
const held = new Map<string, Held>()
const loaded = new Map<string, Held>()

export const heldHydra = ({ hydraId }: { hydraId: string }) => held.get(homeScoped({ hydraId }))

// One snapshot of every table, so a load never mixes two commits another process made between its reads.
const rowsOf = ({ hydraId }: { hydraId: string }) => stateFromRows({
  hydraId,
  results: query({
    transaction: true,
    statements: [
      { text: 'set transaction isolation level repeatable read, read only' },
      ...loadStatements({ hydraId }),
    ],
  }).slice(1),
})

// Another process that imported the same log first leaves its rows, which this read then takes.
function importOnce({
  hydraId,
  dir,
}: {
  hydraId: string
  dir: string
}): boolean {
  try {
    return importLegacy({
      hydraId,
      dir,
    })
  } catch (error) {
    if (error instanceof HydraError && error.code === 'CONFLICT') {
      return true
    }

    throw error
  }
}

// A Hydra still kept in its events.jsonl moves into Postgres the first time it is read, in one transaction; the file
// stays as it was, as a backup. A trial imports it in a transaction it rolls back. Returns whether there was one.
export function importLegacy({
  hydraId,
  dir,
  trial = false,
}: {
  hydraId: string
  dir: string
  trial?: boolean
}): boolean {
  const legacy = existsSync(logPath({ dir })) ? readLog({ dir }) : null

  if (!legacy?.events.length) {
    return false
  }

  storable({ value: legacy })
  importHydra({
    hydraId,
    events: legacy.events,
    transactions: legacy.transactions,
    trial,
  })

  if (!trial) {
    log({
      operation: 'hydra.import',
      hydraId,
      count: legacy.events.length,
    })
  }

  return true
}

function readHydra({
  hydraId,
  migrate,
}: {
  hydraId: string
  migrate: boolean
}): Held {
  const dir = hydraDir({
    hydraId,
    migrate,
  })
  let rows = rowsOf({ hydraId })

  if (!rows && importOnce({
    hydraId,
    dir,
  })) {
    rows = rowsOf({ hydraId })
  }

  return {
    dir,
    state: rows?.state ?? emptyHydra(),
    saved: rows?.saved ?? emptySaved(),
    changed: () => undefined,
  }
}

// The server keeps the Hydra in memory from here until the returned release, as the only writer of its rows.
export function holdHydra({
  hydraId,
  changed,
}: {
  hydraId: string
  changed(): void
}): () => void {
  const entry: Held = {
    ...readHydra({
      hydraId,
      migrate: true,
    }),
    changed,
  }
  const key = homeScoped({ hydraId })
  held.set(
    key,
    entry,
  )

  return () => {
    if (held.get(key) === entry) {
      held.delete(key)
    }
  }
}

// A write that failed after changing the state in memory reads the Hydra back from its committed rows.
export function reloadHydra({ hydraId }: { hydraId: string }): void {
  const key = homeScoped({ hydraId })
  const live = held.get(key)
  loaded.delete(key)

  if (!live) {
    return
  }

  try {
    const fresh = readHydra({
      hydraId,
      migrate: false,
    })
    live.state = fresh.state
    live.saved = fresh.saved
    live.stale = false
  } catch (error) {
    // The state in memory still holds the refused write, so the server is not told to show it; the next read retries.
    live.stale = true
    log({
      level: 'error',
      operation: 'hydra.reload',
      hydraId,
      error,
    })

    return
  }

  live.changed()
}

// The Hydra a write starts from: the held one, or this process's copy while no other process has moved its seq.
export function writableHydra({
  hydraId,
  migrate = true,
}: {
  hydraId: string
  migrate?: boolean
}): Held {
  const key = homeScoped({ hydraId })
  const live = held.get(key)

  if (live?.stale) {
    const fresh = readHydra({
      hydraId,
      migrate,
    })
    live.state = fresh.state
    live.saved = fresh.saved
    live.stale = false
  }

  if (live) {
    return live
  }

  const known = loaded.get(key)
  const [rows] = query({
    statements: [
      {
        text: 'select seq from hydras where id = $1',
        values: [hydraId],
      },
    ],
  })
  const seq = Number(rows?.[0]?.seq ?? 0)

  if (known && known.state.seq === seq) {
    return known
  }

  const fresh = readHydra({
    hydraId,
    migrate,
  })
  loaded.set(
    key,
    fresh,
  )

  return fresh
}

// Reads return the live state; callers must treat it as read-only.
export function loadHydra({
  hydraId,
  migrate = true,
}: {
  hydraId: string
  migrate?: boolean
}): HydraSnapshot {
  const {
    dir,
    state,
  } = writableHydra({
    hydraId,
    migrate,
  })

  return {
    dir,
    state,
  }
}

export function hydraExists({ hydraId }: { hydraId: string }): boolean {
  const [rows] = query({
    statements: [
      {
        text: 'select 1 from hydras where id = $1',
        values: [hydraId],
      },
    ],
  })

  return Boolean(rows?.length)
}

// A Hydra exists once its first write committed, or while its events.jsonl waits to be imported; a bare folder, such
// as one a config write made, does not count.
export function requireHydra({ hydraId }: { hydraId: string }): void {
  // Checking leaves a Hydra still in boards/ where it is; only a read or write moves it.
  const waiting = () => existsSync(logPath({
    dir: hydraDir({
      hydraId,
      migrate: false,
    }),
  }))

  const known = hydraId === DEFAULT_HYDRA || heldHydra({ hydraId }) || hydraExists({ hydraId })

  if (!known && !waiting()) {
    throw new HydraError({
      message: `unknown Hydra: ${hydraId}`,
      code: 'NOT_FOUND',
      help: ['Run `pnyx-axi hydra list` for the Hydras, or `pnyx-axi hydra create <id>` to add one'],
    })
  }
}

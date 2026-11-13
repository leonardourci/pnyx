import type { HydraState } from './model.ts'
import { HydraError } from '#store/errors.ts'
import { homeScoped, query } from '#store/postgres.ts'
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
  // Called after each committed write, so the server pushes the change in the same step.
  changed(): void
}

// The server holds each Hydra it serves; any other process keeps what it loaded, checked against the Hydra's seq.
const held = new Map<string, Held>()
const loaded = new Map<string, Held>()

export const heldHydra = ({ hydraId }: { hydraId: string }) => held.get(homeScoped({ hydraId }))

const rowsOf = ({ hydraId }: { hydraId: string }) => stateFromRows({
  hydraId,
  results: query({ statements: loadStatements({ hydraId }) }),
})

// A Hydra still kept in its events.jsonl moves into Postgres the first time it is read, in one transaction; the file
// stays as it was, as a backup.
function importLegacy({
  hydraId,
  dir,
}: {
  hydraId: string
  dir: string
}): boolean {
  const legacy = existsSync(logPath({ dir })) ? readLog({ dir }) : null

  if (!legacy?.events.length) {
    return false
  }

  importHydra({
    hydraId,
    events: legacy.events,
    transactions: legacy.transactions,
  })
  log({
    operation: 'hydra.import',
    hydraId,
    count: legacy.events.length,
  })

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

  if (!rows && importLegacy({
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

  const fresh = readHydra({
    hydraId,
    migrate: false,
  })
  live.state = fresh.state
  live.saved = fresh.saved
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
  const waiting = () => existsSync(logPath({ dir: hydraDir({ hydraId }) }))

  const known = hydraId === DEFAULT_HYDRA || heldHydra({ hydraId }) || hydraExists({ hydraId })

  if (!known && !waiting()) {
    throw new HydraError({
      message: `unknown Hydra: ${hydraId}`,
      code: 'NOT_FOUND',
      help: ['Run `pnyx-axi hydra list` for the Hydras, or `pnyx-axi hydra create <id>` to add one'],
    })
  }
}

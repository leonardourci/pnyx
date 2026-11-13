import type { HydraState } from './model.ts'
import { HydraError } from '#store/errors.ts'
import { homeDatabase, homeScoped, query, storable } from '#store/postgres.ts'
import { hydraDir, DEFAULT_HYDRA } from './home-migration.ts'
import { emptyHydra } from './reducer.ts'
import { emptySaved, loadStatements, stateFromRows, type SavedRows } from './rows.ts'
import { readLog } from './legacy-log.ts'
import { importHydra } from './import.ts'
import { log } from './diagnostics.ts'
import { logPath } from '#store/storage.ts'
import { existsSync, statSync } from 'node:fs'

export interface HydraSnapshot {
  dir: string
  state: HydraState
}

// A Hydra this process keeps in memory: its state as of its last committed write, and the rows that write left.
export type Held = {
  dir: string
  state: HydraState
  saved: SavedRows
  // The seq of the last committed write; state.seq runs ahead of it while a write appends.
  committed: number
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

const TRANSIENT = new Set([
  'DATABASE_UNAVAILABLE',
  'DATABASE_TIMEOUT',
])

// An import that failed, by its log's size and change time, so it is tried again only once the file changes.
const failedImports = new Map<string, {
  size: number
  mtimeMs: number
  error: unknown
}>()

function importOnce({
  hydraId,
  dir,
}: {
  hydraId: string
  dir: string
}): boolean {
  const key = homeScoped({ hydraId })
  const {
    size,
    mtimeMs,
  } = statSync(logPath({ dir }))
  const failed = failedImports.get(key)

  if (failed?.size === size && failed.mtimeMs === mtimeMs) {
    throw failed.error
  }

  try {
    return importLegacy({
      hydraId,
      dir,
    })
  } catch (error) {
    // Postgres down or busy for a moment is no fault of the log, so the next mount tries again.
    if (error instanceof HydraError && TRANSIENT.has(error.code)) {
      throw error
    }

    failedImports.set(
      key,
      {
        size,
        mtimeMs,
        error,
      },
    )
    throw error
  }
}

// A Hydra still kept in its events.jsonl moves into Postgres when the server first holds it, in one transaction; the
// file stays as it was, as a backup, and its size is kept to notice an older Pnyx appending to it. A trial imports it
// in a transaction it rolls back. Returns whether there was one.
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
    bytes: legacy.bytes,
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

const waitingLog = ({ dir }: { dir: string }) => existsSync(logPath({ dir }))

// An older Pnyx reads events.jsonl and knows nothing of Postgres, so what it appended after the import is not here.
function requireUnchangedLog({
  hydraId,
  dir,
  importedBytes,
}: {
  hydraId: string
  dir: string
  importedBytes: number
}): void {
  const path = logPath({ dir })
  const bytes = existsSync(path) ? statSync(path).size : importedBytes

  if (bytes === importedBytes) {
    return
  }

  throw new HydraError({
    message: `events.jsonl of Hydra ${hydraId} changed after it moved to Postgres (${importedBytes} bytes then, ${bytes} now), so an older Pnyx wrote events Postgres does not have`,
    code: 'LOG_CHANGED',
    help: [
      `To keep the log's version, delete the Hydra's rows (\`psql ${homeDatabase()} -c "delete from hydras where id = '${hydraId}'"\`) and run \`pnyx-axi restart\`, which imports the log again`,
      `To keep Postgres's version, move ${path} aside and run \`pnyx-axi restart\``,
    ],
  })
}

// Only the server imports, when it holds a Hydra; any other read of a Hydra still waiting in its log is refused, so a
// command never imports while an older server still appends to that log.
function readHydra({
  hydraId,
  migrate,
  importing = false,
}: {
  hydraId: string
  migrate: boolean
  importing?: boolean
}): Held {
  const dir = hydraDir({
    hydraId,
    migrate,
  })
  let rows = rowsOf({ hydraId })

  if (!rows && waitingLog({ dir })) {
    if (!importing) {
      throw new HydraError({
        message: `Hydra ${hydraId} is still in its events.jsonl; the server imports it when it starts`,
        code: 'NOT_IMPORTED',
        help: ['Run `pnyx-axi restart`, or try again once the server has started'],
      })
    }

    if (importOnce({
      hydraId,
      dir,
    })) {
      rows = rowsOf({ hydraId })
    }
  }

  if (rows?.importedBytes !== undefined) {
    requireUnchangedLog({
      hydraId,
      dir,
      importedBytes: rows.importedBytes,
    })
  }

  return {
    dir,
    state: rows?.state ?? emptyHydra(),
    saved: rows?.saved ?? emptySaved(),
    committed: rows?.state.seq ?? 0,
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
      importing: true,
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
    live.committed = fresh.committed
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
    live.committed = fresh.committed
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
  const waiting = () => waitingLog({
    dir: hydraDir({
      hydraId,
      migrate: false,
    }),
  })

  const known = hydraId === DEFAULT_HYDRA || heldHydra({ hydraId }) || hydraExists({ hydraId })

  if (!known && !waiting()) {
    throw new HydraError({
      message: `unknown Hydra: ${hydraId}`,
      code: 'NOT_FOUND',
      help: ['Run `pnyx-axi hydra list` for the Hydras, or `pnyx-axi hydra create <id>` to add one'],
    })
  }
}

import type { HydraState } from './model.ts'
import { HydraError } from '#store/errors.ts'
import { query } from '#store/postgres.ts'
import { hydraDir, DEFAULT_HYDRA } from './home-migration.ts'
import { emptyHydra } from './reducer.ts'
import { emptySaved, loadStatements, stateFromRows, type SavedRows } from './rows.ts'

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

export const heldHydra = ({ hydraId }: { hydraId: string }) => held.get(hydraId)

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
  const rows = stateFromRows({
    hydraId,
    results: query({ statements: loadStatements({ hydraId }) }),
  })

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

// A write that failed after changing the state in memory reads the Hydra back from its committed rows.
export function reloadHydra({ hydraId }: { hydraId: string }): void {
  const live = held.get(hydraId)
  loaded.delete(hydraId)

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
  const live = held.get(hydraId)

  if (live) {
    return live
  }

  const known = loaded.get(hydraId)
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
    hydraId,
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

// A Hydra exists once its first write committed; a bare folder, such as one a config write made, does not count.
export function requireHydra({ hydraId }: { hydraId: string }): void {
  if (hydraId !== DEFAULT_HYDRA && !held.has(hydraId) && !hydraExists({ hydraId })) {
    throw new HydraError({
      message: `unknown Hydra: ${hydraId}`,
      code: 'NOT_FOUND',
      help: ['Run `pnyx-axi hydra list` for the Hydras, or `pnyx-axi hydra create <id>` to add one'],
    })
  }
}

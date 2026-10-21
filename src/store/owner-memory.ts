import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkBudget, OWNER_DOCUMENTS, OWNER_MEMORY_BUDGET, type Memory } from '../core/digest.ts'
import { hydraEvent } from '../core/hydra.ts'
import { HydraError } from '../core/model.ts'
import type { Meta } from '../core/decide.ts'
import { hydraIds, loadHydra, pnyxHome, privateDir, withRegistryLock, withWriter, writeDurably } from './hydra-store.ts'

// One replacement or removal of an owner memory key; the log is only appended, so every old version stays.
interface OwnerEntry {
  v: 1
  seq: number
  at: string
  actor: string
  reason?: string
  key: string
  before: string | null
  after: string | null
}

interface OwnerLog {
  memory: Memory
  revision: number
  // A line that does not parse; reads skip it, writes refuse until someone inspects the log.
  corrupt: boolean
}

const ownerDir = () => join(
  pnyxHome(),
  'owner',
)
const logPath = () => join(
  ownerDir(),
  'memory.jsonl',
)
const migratedPath = () => join(
  ownerDir(),
  'migrated',
)

function readLog(): OwnerLog {
  let text = ''

  try {
    text = readFileSync(
      logPath(),
      'utf8',
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }

  // Keys come from disk, so a key such as __proto__ must stay an ordinary key.
  const memory: Memory = Object.create(null) as Memory
  let revision = 0
  let corrupt = Boolean(text) && !text.endsWith('\n')

  for (const line of text.split('\n').filter(Boolean)) {
    let entry: OwnerEntry | undefined

    try {
      entry = JSON.parse(line) as OwnerEntry
    } catch {
      entry = undefined
    }

    if (typeof entry?.key !== 'string' || (entry.after !== null && typeof entry.after !== 'string')) {
      corrupt = true
      continue
    }

    revision = entry.seq

    if (entry.after === null) {
      delete memory[entry.key]
    } else {
      memory[entry.key] = {
        text: entry.after,
        at: entry.at,
      }
    }
  }

  return {
    memory,
    revision,
    corrupt,
  }
}

// Call only under the registry lock. `change` gets the current text and returns the new one.
function append({
  key,
  change,
  meta,
  budget,
}: {
  key: string
  change: ({ before }: { before: string | null }) => string | null
  meta: Meta
  budget?: number
}): OwnerEntry | undefined {
  const log = readLog()

  if (log.corrupt) {
    throw new HydraError({
      message: 'Owner memory has an unreadable line; inspect its log before writing',
      code: 'LOG_CORRUPT',
      help: [`Inspect ${logPath()}`],
    })
  }

  if (meta.ifRevision !== undefined && meta.ifRevision !== log.revision) {
    throw new HydraError({
      message: `Owner memory revision is ${log.revision}`,
      code: 'REVISION_CONFLICT',
      help: ['Run `pnyx-axi owner memory list`, merge your change into the current text and save again'],
    })
  }

  const before = log.memory[key]?.text ?? null
  const after = change({ before })

  if (before === after) {
    return undefined
  }

  if (budget !== undefined) {
    checkBudget({
      memory: log.memory,
      key,
      after,
      budget,
      layer: 'Owner',
    })
  }

  const entry: OwnerEntry = {
    v: 1,
    seq: log.revision + 1,
    at: meta.at,
    actor: meta.actor,
    ...(meta.reason ? { reason: meta.reason } : {}),
    key,
    before,
    after,
  }
  privateDir({ dir: ownerDir() })
  writeDurably({
    path: logPath(),
    data: `${JSON.stringify(entry)}\n`,
    flag: 'a',
  })

  return entry
}

// Lines of both documents, each kept once; a line differing only in spacing or case is the same line.
export function mergeLines({ texts }: { texts: string[] }): string {
  const seen = new Set<string>()

  return texts.flatMap(text => text.split('\n'))
    .filter(line => {
      const same = line.trim().replace(
        /\s+/g,
        ' ',
      )
        .toLowerCase()

      if (!same || seen.has(same)) {
        return false
      }

      seen.add(same)

      return true
    })
    .map(line => line.trimEnd())
    .join('\n')
}

// Owner preferences and learnings used to live in each Hydra. The first run after the move merges them
// into owner memory and forgets them in each Hydra, whose event log keeps the old text. The marker is
// written last, so a run cut short, or one a Hydra failed in, repeats and the merge drops lines it already moved.
// ponytail: a Hydra that keeps failing (a held lock, a torn log) makes every owner read retry and wait on its lock.
export function migrateOwnerMemory(): void {
  if (existsSync(migratedPath())) {
    return
  }

  withRegistryLock({
    fn: () => {
      if (existsSync(migratedPath())) {
        return
      }

      const meta = {
        at: new Date().toISOString(),
        actor: 'pnyx',
      }
      const failed: string[] = []

      for (const hydraId of hydraIds()) {
        try {
          const memory = loadHydra({ hydraId }).state.hydraMemory ?? {}

          if (Object.keys(OWNER_DOCUMENTS).some(key => Object.hasOwn(
            memory,
            key,
          ))) {
            move({
              hydraId,
              meta,
            })
          }
        } catch (error) {
          failed.push(`${hydraId}: ${(error as Error).message}`)
        }
      }

      if (failed.length) {
        throw new HydraError({
          message: `Owner memory could not move from ${failed.join('; ')}`,
          code: 'MIGRATION_INCOMPLETE',
          help: ['Fix or `pnyx-axi repair` those Hydras; the next read retries the move'],
        })
      }

      privateDir({ dir: ownerDir() })
      writeDurably({
        path: migratedPath(),
        data: `${meta.at}\n`,
        flag: 'w',
      })
    },
  })
}

function move({
  hydraId,
  meta,
}: {
  hydraId: string
  meta: Meta
}): void {
  withWriter({
    hydraId,
    fn: ({ writer }) => {
      for (const key of Object.keys(OWNER_DOCUMENTS)) {
        const held = writer.state.hydraMemory?.[key]?.text

        if (held === undefined) {
          continue
        }

        append({
          key,
          change: ({ before }) => mergeLines({
            texts: [
              before ?? '',
              held,
            ],
          }),
          meta: {
            ...meta,
            reason: `Moved ${key} from Hydra ${hydraId}`,
          },
        })
        const forget = hydraEvent({
          state: writer.state,
          meta: {
            ...meta,
            reason: 'Moved to the Pnyx-wide owner memory',
          },
          cardId: '$board',
          change: {
            type: 'hydra.memory',
            data: {
              key,
              before: held,
              after: null,
            },
          },
        })

        if ('event' in forget) {
          writer.append({ event: forget.event })
        }
      }
    },
  })
}

// The documents stay in their Hydra's digest until the move succeeds, so a failed move only reports.
function tryMigrate(): void {
  try {
    migrateOwnerMemory()
  } catch (error) {
    console.error(`pnyx-axi: ${(error as Error).message}`)
  }
}

// Reading first moves any owner documents still held by a Hydra, so read a Hydra's state after this.
export function ownerMemory(): Memory {
  tryMigrate()

  return readLog().memory
}

export function ownerRevision(): number {
  return readLog().revision
}

export function saveOwnerMemory({
  key,
  after,
  meta,
}: {
  key: string
  after: string | null
  meta: Meta
}): OwnerEntry | undefined {
  tryMigrate()

  return withRegistryLock({
    fn: () => append({
      key,
      change: () => after,
      meta,
      budget: OWNER_MEMORY_BUDGET,
    }),
  })
}

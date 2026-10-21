import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkBudget, OWNER_MEMORY_BUDGET, type Memory } from '../core/digest.ts'
import { hydraEvent } from '../core/hydra.ts'
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

// ponytail: a torn or unreadable line is skipped rather than repaired; appends start on a fresh line.
function readLog(): {
  entries: OwnerEntry[]
  text: string
} {
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

  return {
    text,
    entries: text.split('\n').flatMap(line => {
      try {
        const entry = JSON.parse(line) as OwnerEntry

        return typeof entry?.key === 'string' ? [entry] : []
      } catch {
        return []
      }
    }),
  }
}

const fold = ({ entries }: { entries: OwnerEntry[] }): Memory => {
  const memory: Memory = {}

  for (const entry of entries) {
    if (entry.after === null) {
      delete memory[entry.key]
    } else {
      memory[entry.key] = {
        text: entry.after,
        at: entry.at,
      }
    }
  }

  return memory
}

// Call only under the registry lock.
function append({
  key,
  after,
  meta,
  budget,
}: {
  key: string
  after: string | null
  meta: Meta
  budget?: number
}): OwnerEntry | undefined {
  const {
    entries,
    text,
  } = readLog()
  const memory = fold({ entries })
  const before = Object.hasOwn(
    memory,
    key,
  ) ? memory[key]!.text : null

  if (before === after) {
    return undefined
  }

  if (budget !== undefined) {
    checkBudget({
      memory,
      key,
      after,
      budget,
      layer: 'Owner',
    })
  }

  const entry: OwnerEntry = {
    v: 1,
    seq: (entries.at(-1)?.seq ?? 0) + 1,
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
    data: `${text && !text.endsWith('\n') ? '\n' : ''}${JSON.stringify(entry)}\n`,
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

// Owner preferences used to live in each Hydra. The first run after the move merges them into owner
// memory and forgets them in each Hydra, whose event log keeps the old text. The marker is written
// last, so a run cut short, or one a Hydra failed in, repeats and the merge drops the lines it already moved.
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

      let failed = false

      for (const hydraId of hydraIds()) {
        try {
          if (loadHydra({ hydraId }).state.hydraMemory?.preferences !== undefined) {
            move({
              hydraId,
              meta,
            })
          }
        } catch {
          failed = true
        }
      }

      if (!failed) {
        privateDir({ dir: ownerDir() })
        writeDurably({
          path: migratedPath(),
          data: `${meta.at}\n`,
          flag: 'w',
        })
      }
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
      const held = writer.state.hydraMemory?.preferences?.text

      if (held === undefined) {
        return
      }

      append({
        key: 'preferences',
        after: mergeLines({
          texts: [
            fold({ entries: readLog().entries }).preferences?.text ?? '',
            held,
          ],
        }),
        meta: {
          ...meta,
          reason: `Moved owner preferences from Hydra ${hydraId}`,
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
            key: 'preferences',
            before: held,
            after: null,
          },
        },
      })

      if ('event' in forget) {
        writer.append({ event: forget.event })
      }
    },
  })
}

export function ownerMemory(): Memory {
  try {
    migrateOwnerMemory()
  } catch {
    // A failed move leaves the preferences in their Hydra's digest, and the next read retries it.
  }

  return fold({ entries: readLog().entries })
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
  migrateOwnerMemory()

  return withRegistryLock({
    fn: () => append({
      key,
      after,
      meta,
      budget: OWNER_MEMORY_BUDGET,
    }),
  })
}

import { ownerMemoryLogPath as logPath, readOwnerEntries, type OwnerEntry } from './owner-memory-log.ts'
import { projectMemoryViewUnderLock, checkProjectMemoryBudget, type ProjectMemoryEvent } from '../projects/memory.ts'
import { dateLearnings, learningText, type LearningChange, type Learning } from '../memory/learnings.ts'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { checkBudget, OWNER_DOCUMENTS, OWNER_MEMORY_BUDGET, type Memory } from '../core/digest.ts'
import { hydraEvent } from '../core/hydra.ts'
import { HydraError } from '../core/model.ts'
import type { Meta } from '../app/command-meta.ts'
import { hydraIds } from '../app/home-migration.ts'
import { loadHydra } from '../app/store.ts'
import { withWriter } from '../app/writer.ts'
import { pnyxHome, privateDir, withRegistryLock, writeDurably } from './storage.ts'

interface OwnerLog {
  memory: Memory
  revision: number
  archived: Learning[]
  // A line that does not parse; reads skip it, writes refuse until someone inspects the log.
  corrupt: boolean
}

const ownerDir = () => join(
  pnyxHome(),
  'owner',
)
const migratedPath = () => join(
  ownerDir(),
  'migrated',
)

function readLog(): OwnerLog {
  const {
    entries,
    corrupt,
  } = readOwnerEntries()
  const memory: Memory = Object.create(null) as Memory
  const archived: Learning[] = []
  let revision = 0

  for (const entry of entries) {
    revision = entry.seq

    const retired = memory.learnings?.lines?.find(line => line.text === entry.learning?.archive)

    if (retired) {
      archived.push(retired)
    }

    if (entry.after === null) {
      delete memory[entry.key]
    } else {
      const previous = memory[entry.key]?.lines
      memory[entry.key] = {
        text: entry.after,
        at: entry.at,
      }

      if (entry.key === 'learnings') {
        memory[entry.key]!.lines = dateLearnings({
          before: previous,
          after: entry.after,
          at: entry.at,
          confirmed: entry.confirmed,
          evidence: entry.reason,
          change: entry.learning,
        })
      }
    }
  }

  return {
    memory,
    revision,
    archived,
    corrupt,
  }
}

// Call only under the registry lock. `change` gets the current text and returns the new one.
function append({
  key,
  change,
  meta,
  budget,
  confirmed,
  projectMove,
  learning,
}: {
  key: string
  change: ({ before }: { before: string | null }) => string | null
  meta: Meta
  budget?: number
  confirmed?: string
  projectMove?: OwnerEntry['projectMove']
  learning?: LearningChange
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
  const after = learningText({
    before,
    after: change({ before }),
    confirmed,
    change: learning,
  })

  if ((confirmed !== undefined || learning !== undefined) && key !== 'learnings') {
    throw new HydraError({
      message: 'Only learnings need reconfirmation',
      code: 'VALIDATION_ERROR',
    })
  }

  if (key === 'learnings') {
    dateLearnings({
      before: log.memory[key]?.lines,
      after,
      at: meta.at,
      confirmed,
      evidence: meta.reason,
      change: learning,
    })
  }

  if (before === after && confirmed === undefined && learning === undefined) {
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

  if (confirmed !== undefined) {
    entry.confirmed = confirmed
  }

  if (projectMove) {
    entry.projectMove = projectMove
  }

  if (learning) {
    entry.learning = learning
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

export function ownerArchive(): Learning[] {
  return readLog().archived
}

export function ownerRevision(): number {
  return readLog().revision
}

export function saveOwnerMemory({
  key,
  after,
  meta,
  confirmed,
  learning,
}: {
  key: string
  after: string | null
  meta: Meta
  confirmed?: string
  learning?: LearningChange
}): OwnerEntry | undefined {
  tryMigrate()

  return withRegistryLock({
    fn: () => append({
      key,
      change: ({ before }) => confirmed === undefined ? after : before,
      meta,
      budget: OWNER_MEMORY_BUDGET,
      confirmed,
      learning,
    }),
  })
}

export function moveOwnerLearning({
  path,
  hydraId,
  text,
  meta,
}: {
  path: string
  hydraId: string
  text: string
  meta: Meta
}) {
  tryMigrate()

  return withRegistryLock({
    fn: () => {
      const owner = readLog()
      const before = owner.memory.learnings?.text ?? ''
      const lines = before.split('\n')

      if (!text.trim() || text.includes('\n') || !lines.includes(text)) {
        throw new HydraError({
          message: 'Move one existing owner learning line exactly',
          code: 'VALIDATION_ERROR',
        })
      }

      const project = projectMemoryViewUnderLock({ path })
      const projectBefore = project.documents.learnings ?? null
      const projectLines = (projectBefore ?? '').split('\n')
      let projectAfter = projectBefore ?? ''

      if (!projectLines.includes(text)) {
        projectAfter = [
          projectBefore,
          text,
        ].filter(Boolean).join('\n')
      }

      checkProjectMemoryBudget({
        memory: project,
        key: 'learnings',
        after: projectAfter,
      })
      const projectEvent: ProjectMemoryEvent = {
        v: 1,
        id: `owner-move:${owner.revision + 1}`,
        seq: project.revision + 1,
        at: meta.at,
        actor: meta.actor,
        reason: meta.reason,
        hydra: hydraId,
        identity: project.identity,
        key: 'learnings',
        before: projectBefore,
        after: projectAfter,
        importedLearning: owner.memory.learnings?.lines?.find(line => line.text === text.trim()),
      }
      const remaining = lines.filter(line => line !== text).join('\n')
      const entry = append({
        key: 'learnings',
        change: () => remaining || null,
        meta,
        budget: OWNER_MEMORY_BUDGET,
        projectMove: {
          project: project.id,
          event: projectEvent,
        },
      })

      return {
        memory: 'learnings',
        state: 'moved',
        project: project.id,
        revision: entry?.seq,
      }
    },
  })
}

import { checkWorkerNotes } from './workers.ts'
import { readSettings } from '#settings/store.ts'
import { canRead, polisAccess, memoryMovePermission } from './poleis.ts'
import { log } from '#app/diagnostics.ts'
import { ownerMemoryLogPath as logPath, readOwnerEntries, type OwnerEntry } from './owner-memory-log.ts'
import { projectFacts, projectMemoryViewUnderLock, checkProjectMemoryBudget, type ProjectMemoryEvent } from './project-memory.ts'
import { archiveRemoved, dateLearnings, learningText, type ArchivedLine, type LearningChange } from './learnings.ts'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { checkBudget, OWNER_DOCUMENTS, OWNER_MEMORY_BUDGET, type Memory } from './budgets.ts'
import { hydraEvent } from '#hydra/hydra.ts'
import { HydraError } from '#store/errors.ts'
import type { Meta } from '#app/command-meta.ts'
import { hydraIds } from '#app/home-migration.ts'
import { loadHydra } from '#app/store.ts'
import { withWriter } from '#app/writer.ts'
import { pnyxHome, privateDir, withRegistryLock, writeDurably } from '#store/storage.ts'

interface OwnerLog {
  memory: Memory
  revision: number
  archived: ArchivedLine[]
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

function readLog({ polis = 'shared' }: { polis?: string } = {}): OwnerLog {
  const {
    entries,
    corrupt,
  } = readOwnerEntries({ polis })
  const memory: Memory = Object.create(null) as Memory
  let archived: ArchivedLine[] = []
  let revision = 0

  for (const entry of entries) {
    revision = entry.seq

    // Moved lines remain in destination memory.
    if (!entry.projectMove && !entry.polisMove) {
      archived = archiveRemoved({
        archived,
        key: entry.key,
        before: memory[entry.key]?.text ?? null,
        after: entry.after,
        at: entry.at,
        reason: entry.reason,
      })
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
          before: [
            ...(previous ?? []),
            ...(entry.importedLearnings ?? []),
          ],
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
  polisMove,
  learning,
  polis = 'shared',
}: {
  polis?: string
  key: string
  change: ({ before }: { before: string | null }) => string | null
  meta: Meta
  budget?: number
  confirmed?: string
  polisMove?: OwnerEntry['polisMove']
  projectMove?: OwnerEntry['projectMove']
  learning?: LearningChange
}): OwnerEntry | undefined {
  const log = readLog({ polis })

  if (log.corrupt) {
    throw new HydraError({
      message: 'Owner memory has an unreadable line; inspect its log before writing',
      code: 'LOG_CORRUPT',
      help: [`Inspect ${logPath({ polis })}`],
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

  if (polisMove) {
    entry.polisMove = polisMove
  }

  if (learning) {
    entry.learning = learning
  }

  privateDir({ dir: dirname(logPath({ polis })) })
  writeDurably({
    path: logPath({ polis }),
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
          help: ['Fix the error named for those Hydras; the next read retries the move'],
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
    log({
      level: 'error',
      operation: 'memory.migrate',
      error,
    })
  }
}

// Reading first moves any owner documents still held by a Hydra, so read a Hydra's state after this.
export function ownerMemory({
  hydraId,
  migrate = true,
}: {
  hydraId: string
  migrate?: boolean
}): Memory {
  if (migrate) {
    tryMigrate()
  }

  const memory: Memory = Object.create(null) as Memory

  for (const polis of polisAccess({ hydraId }).reads) {
    for (const [
      key,
      entry,
    ] of Object.entries(readLog({ polis }).memory)) {
      const previous = memory[key]
      memory[key] = previous ? {
        text: mergeLines({
          texts: [
            previous.text,
            entry.text,
          ],
        }),
        at: entry.at,
        lines: [
          ...(previous.lines ?? []),
          ...(entry.lines ?? []),
        ],
      } : entry
    }
  }

  return memory
}

export function ownerArchive({ hydraId }: { hydraId: string }): ArchivedLine[] {
  return polisAccess({ hydraId }).reads.flatMap(polis => readLog({ polis }).archived)
}

export function writableOwnerMemory({ hydraId }: { hydraId: string }) {
  const { writablePolis } = polisAccess({ hydraId })

  return writablePolis === undefined ? undefined : readLog({ polis: writablePolis })
}

export function saveOwnerMemory({
  hydraId,
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
  hydraId: string
}): OwnerEntry | undefined {
  tryMigrate()

  return withRegistryLock({
    fn: () => append({
      polis: polisAccess({ hydraId }).write(),
      key,
      change: ({ before }) => confirmed === undefined ? after : before,
      meta,
      budget: OWNER_MEMORY_BUDGET,
      confirmed,
      learning,
    }),
  })
}

export async function moveOwnerLearning({
  args,
  propose = false,
  ifDestinationRevision,
  path,
  hydraId,
  text,
  meta,
}: {
  args: string[]
  propose?: boolean
  ifDestinationRevision?: number
  path: string
  hydraId: string
  text: string
  meta: Meta
}) {
  tryMigrate()
  const facts = await projectFacts({ path })

  return withRegistryLock({
    fn: () => {
      const polis = polisAccess({ hydraId }).write()
      const owner = readLog({ polis })

      if (meta.ifRevision !== undefined && owner.revision !== meta.ifRevision) {
        throw new HydraError({
          message: 'Source memory changed; read it again before moving the learning',
          code: 'REVISION_CONFLICT',
        })
      }

      const before = owner.memory.learnings?.text ?? ''
      const lines = before.split('\n')

      if (!text.trim() || text.includes('\n') || !lines.includes(text)) {
        throw new HydraError({
          message: 'Move one existing owner learning line exactly',
          code: 'VALIDATION_ERROR',
        })
      }

      const project = projectMemoryViewUnderLock({
        facts,
        hydraId,
      })

      if (ifDestinationRevision !== undefined && project.revision !== ifDestinationRevision) {
        throw new HydraError({
          message: 'Destination memory changed; propose the move again',
          code: 'REVISION_CONFLICT',
        })
      }

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
      const proposal = memoryMovePermission({
        hydraId,
        args,
        propose,
        actor: meta.actor,
        revision: owner.revision,
        destinationRevision: project.revision,
        destination: readSettings().settings.projectPoleis[facts.identity.id] ?? 'shared',
      })

      if (proposal) {
        return proposal
      }

      const projectEvent: ProjectMemoryEvent = {
        v: 1,
        id: polis === 'shared' ? `owner-move:${owner.revision + 1}` : `owner-move:${polis}:${owner.revision + 1}`,
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
        polis,
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

export function moveOwnerPolis({
  args,
  propose = false,
  ifDestinationRevision,
  hydraId,
  destination,
  key,
  meta,
}: {
  args: string[]
  propose?: boolean
  ifDestinationRevision?: number
  hydraId: string
  destination: string
  key: string
  meta: Meta
}) {
  tryMigrate()

  return withRegistryLock({
    fn: () => {
      const polis = polisAccess({ hydraId }).write()
      const state = loadHydra({ hydraId }).state

      if (!canRead({
        hydraId,
        state,
        poleis: readSettings().settings.poleis,
        polis: destination,
      })) {
        throw new HydraError({
          message: 'Memory is unavailable',
          code: 'NOT_FOUND',
        })
      }

      if (polis === destination) {
        return { skipped: 'unchanged' }
      }

      const source = readLog({ polis })
      const target = readLog({ polis: destination })

      if (meta.ifRevision !== undefined && source.revision !== meta.ifRevision) {
        throw new HydraError({
          message: 'Source memory changed; read it again before moving the document',
          code: 'REVISION_CONFLICT',
        })
      }

      if (ifDestinationRevision !== undefined && target.revision !== ifDestinationRevision) {
        throw new HydraError({
          message: 'Destination memory changed; propose the move again',
          code: 'REVISION_CONFLICT',
        })
      }

      if (source.corrupt || target.corrupt) {
        throw new HydraError({
          message: 'Memory log is unreadable',
          code: 'LOG_CORRUPT',
        })
      }

      const text = source.memory[key]?.text

      if (text === undefined) {
        throw new HydraError({
          message: 'Memory is unavailable',
          code: 'NOT_FOUND',
        })
      }

      const after = mergeLines({
        texts: [
          target.memory[key]?.text ?? '',
          text,
        ],
      })

      if (key === 'workers') {
        checkWorkerNotes({
          text: after,
          reason: meta.reason,
        })
      }

      checkBudget({
        memory: target.memory,
        key,
        after,
        budget: OWNER_MEMORY_BUDGET,
        layer: 'Owner',
      })
      const proposal = memoryMovePermission({
        hydraId,
        destination,
        args,
        propose,
        actor: meta.actor,
        revision: source.revision,
        destinationRevision: target.revision,
      })

      if (proposal) {
        return proposal
      }

      const entry = append({
        polis,
        key,
        change: () => null,
        meta,
        polisMove: {
          polis: destination,
          entry: {
            v: 1,
            seq: target.revision + 1,
            at: meta.at,
            actor: meta.actor,
            reason: meta.reason,
            key,
            before: target.memory[key]?.text ?? null,
            after,
            importedLearnings: source.memory[key]?.lines,
          },
        },
      })

      return {
        memory: key,
        state: 'moved',
        revision: entry?.seq,
      }
    },
  })
}

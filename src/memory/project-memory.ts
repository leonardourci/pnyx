import { inform } from '#app/command-notices.ts'
import { loadHydra } from '#app/store.ts'
import { findProject } from '#projects/read.ts'
import { requireProjectMemory } from './poleis.ts'
import { INSCRIBE_SKILL } from '#setup/skill-names.ts'
import { ownerProjectMoves } from './owner-memory-log.ts'
import { checkWorkerNotes, workerNotesNotice } from './workers.ts'
import { archiveRemoved, dateLearnings, informReinforcement, learningText, type ArchivedLine, type LearningChange, type Learning } from './learnings.ts'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Meta } from '#app/command-meta.ts'
import { HydraError } from '#store/errors.ts'
import { withWriter } from '#app/writer.ts'
import { privateDir, withRegistryLock } from '#store/storage.ts'
import { pnyxHome } from '#store/paths.ts'
import { projectIdentity, projectSources } from '#projects/sources.ts'

export const PROJECT_MEMORY_BUDGET = 10000
export const PROJECT_MEMORY_NEARLY_FULL = 0.8
export const PROJECT_MEMORY_DOCUMENTS = {
  profile: 'Profile',
  preferences: 'Project owner preferences',
  learnings: 'Project learnings',
  workers: 'Standing worker instructions',
} as const
export type ProjectMemoryKey = keyof typeof PROJECT_MEMORY_DOCUMENTS

export interface ProjectMemoryEvent {
  v: 1
  id: string
  seq: number
  at: string
  actor: string
  reason?: string
  confirmed?: string
  learning?: LearningChange
  hydra: string
  identity: string
  key: ProjectMemoryKey
  before: string | null
  after: string | null
  sources?: Record<string, string>
  importedLearning?: Learning
}

export interface ProjectMemory {
  revision: number
  learnings?: Learning[]
  archived: ArchivedLine[]
  documents: Partial<Record<ProjectMemoryKey, string>>
  sources: Record<string, string>
  events: ProjectMemoryEvent[]
}

const projectMemorySize = ({ documents }: Pick<ProjectMemory, 'documents'>) => Object.values(documents).reduce(
  (
    size,
    text,
  ) => size + text.length,
  0,
)

function memoryPath({ id }: { id: string }) {
  return join(
    pnyxHome(),
    'projects',
    id,
    'events.jsonl',
  )
}

export function readProjectMemory({
  id,
  hydraId,
}: {
  id: string
  hydraId: string
}): ProjectMemory {
  return withRegistryLock({
    fn: () => {
      requireProjectMemory({
        hydraId,
        id,
      })

      return readProjectMemoryLog({ id })
    },
  })
}

function readProjectMemoryLog({ id }: { id: string }): ProjectMemory {
  const file = memoryPath({ id })
  const memory: ProjectMemory = {
    revision: 0,
    archived: [],
    documents: {},
    sources: {},
    events: [],
  }

  const events = ownerProjectMoves({ id })
  const text = existsSync(file) ? readFileSync(
    file,
    'utf8',
  ) : ''

  if (text && !text.endsWith('\n')) {
    throw new HydraError({
      message: 'Project memory has an incomplete event; inspect its log before writing',
      code: 'LOG_CORRUPT',
    })
  }

  for (const line of text.split('\n').filter(Boolean)) {
    try {
      events.push(JSON.parse(line))
    } catch {
      throw new HydraError({
        message: 'Project memory contains an invalid event',
        code: 'LOG_CORRUPT',
      })
    }
  }

  events.sort((
    left,
    right,
  ) => (left?.seq ?? 0) - (right?.seq ?? 0))

  for (const event of events) {
    if (!event || typeof event !== 'object' || event.v !== 1 || event.seq !== memory.revision + 1 || !Object.hasOwn(
      PROJECT_MEMORY_DOCUMENTS,
      event.key,
    ) || (event.after !== null && typeof event.after !== 'string')) {
      throw new HydraError({
        message: 'Project memory contains an invalid event',
        code: 'LOG_CORRUPT',
      })
    }

    // A profile is rebuilt from its sources, so lines it drops are not the owner's to recover.
    if (event.key !== 'profile') {
      memory.archived = archiveRemoved({
        archived: memory.archived,
        key: event.key,
        before: memory.documents[event.key] ?? null,
        after: event.after,
        at: event.at,
        reason: event.reason,
      })
    }

    if (event.after === null) {
      delete memory.documents[event.key]
    } else {
      memory.documents[event.key] = event.after
    }

    if (event.key === 'learnings') {
      memory.learnings = dateLearnings({
        before: mergeImportedLearning({
          learnings: memory.learnings ?? [],
          imported: event.importedLearning,
        }),
        after: event.after,
        at: event.at,
        confirmed: event.confirmed,
        evidence: event.reason,
        change: event.learning,
      })
    }

    if (event.key === 'profile') {
      memory.sources = event.sources ?? {}
    }

    memory.events.push(event)
    memory.revision = event.seq
  }

  return memory
}

function profileStatus({
  present,
  available,
  changed,
}: {
  present: boolean
  available: boolean
  changed: boolean
}) {
  if (!available) {
    return 'unavailable'
  }

  if (!present) {
    return 'missing'
  }

  return changed ? 'out of date' : 'current'
}

// What git says about a project, read off the event loop before any lock is taken.
export type ProjectFacts = {
  path: string
  identity: Awaited<ReturnType<typeof projectIdentity>>
  sources: Awaited<ReturnType<typeof projectSources>>
}

export async function projectFacts({ path }: { path: string }): Promise<ProjectFacts> {
  const [
    identity,
    sources,
  ] = await Promise.all([
    projectIdentity({ path }),
    projectSources({ path }),
  ])

  return {
    path,
    identity,
    sources,
  }
}

export async function projectMemoryView({
  path,
  hydraId,
  writing = false,
}: {
  path: string
  hydraId: string
  writing?: boolean
}) {
  const facts = await projectFacts({ path })

  return withRegistryLock({
    fn: () => projectMemoryViewUnderLock({
      facts,
      hydraId,
      writing,
    }),
  })
}

export async function readableProjectMemory({
  path,
  hydraId,
}: {
  path: string
  hydraId: string
}) {
  try {
    return await projectMemoryView({
      path,
      hydraId,
    })
  } catch (error) {
    if (error instanceof HydraError && error.code === 'NOT_FOUND') {
      return undefined
    }

    throw error
  }
}

export function projectMemoryViewUnderLock({
  facts,
  hydraId,
  writing = false,
}: {
  facts: ProjectFacts
  hydraId: string
  writing?: boolean
}) {
  const {
    identity,
    sources,
  } = facts
  findProject({
    state: loadHydra({ hydraId }).state,
    ref: facts.path,
    attached: true,
  })
  requireProjectMemory({
    hydraId,
    id: identity.id,
    writing,
  })
  const memory = readProjectMemoryLog(identity)
  const changed = [
    ...new Set([
      ...Object.keys(memory.sources),
      ...Object.keys(sources.hashes),
    ]),
  ]
    .filter(file => memory.sources[file] !== sources.hashes[file]).sort()
  const status = profileStatus({
    present: Boolean(memory.documents.profile),
    available: sources.available,
    changed: changed.length > 0,
  })

  return {
    ...identity,
    ...memory,
    currentSources: sources,
    changed,
    status,
    used: projectMemorySize(memory),
  }
}

export async function writeProjectMemory({
  path,
  hydraId,
  key,
  after,
  sources,
  meta,
  confirmed,
  learning,
}: {
  path: string
  hydraId: string
  key: ProjectMemoryKey
  after: string | null
  sources?: string
  meta: Meta
  confirmed?: string
  learning?: LearningChange
}) {
  if (key === 'workers') {
    checkWorkerNotes({
      command: `pnyx-axi project worker-notes set --project ${JSON.stringify(path)}`,
      text: after,
      reason: meta.reason,
    })
  }

  const facts = await projectFacts({ path })

  return withRegistryLock({
    fn: () => {
      const view = projectMemoryViewUnderLock({
        writing: true,
        facts,
        hydraId,
      })

      const readsLearning = confirmed !== undefined
        || learning?.used !== undefined || learning?.archive !== undefined

      if (readsLearning) {
        requireProjectMemory({
          hydraId,
          id: view.id,
        })
      }

      const previous = view.events.find(event => event.id === meta.id)

      const notify = ({ event }: { event: ProjectMemoryEvent }) => {
        if (event.key !== 'workers') {
          return
        }

        withWriter({
          hydraId: event.hydra,
          fn: ({ writer }) => workerNotesNotice({
            writer,
            target: basename(path),
            meta: {
              id: event.id,
              at: event.at,
              actor: event.actor,
              reason: event.reason,
            },
          }),
        })
      }

      if (previous) {
        notify({ event: previous })

        return {
          project: view.id,
          revision: view.revision,
          skipped: 'duplicate',
        }
      }

      if (meta.ifRevision !== undefined && meta.ifRevision !== view.revision) {
        throw new HydraError({
          message: `Project memory revision is ${view.revision}`,
          code: 'REVISION_CONFLICT',
        })
      }

      if (key === 'profile' && after !== null && (!view.currentSources.available || sources !== view.currentSources.fingerprint)) {
        throw new HydraError({
          message: 'Profile sources are unavailable or changed since they were read',
          code: 'SOURCES_CHANGED',
          help: ['Run project memory list --project <name>; read its changed sources from the listed ref, then save the profile with --sources <fingerprint>'],
        })
      }

      const before = view.documents[key] ?? null

      after = learningText({
        before,
        after,
        confirmed,
        change: learning,
      })

      const used = checkProjectMemoryBudget({
        memory: view,
        key,
        after,
      })

      if ((confirmed !== undefined || learning !== undefined) && key !== 'learnings') {
        throw new HydraError({
          message: 'Only learnings need reconfirmation',
          code: 'VALIDATION_ERROR',
        })
      }

      if (key === 'learnings') {
        informReinforcement({
          confirmed,
          change: learning,
          evidence: meta.reason,
        })
        dateLearnings({
          before: view.learnings,
          after,
          at: meta.at,
          confirmed,
          evidence: meta.reason,
          change: learning,
        })
      }

      if (before === after && confirmed === undefined && learning === undefined && (key !== 'profile' || !view.changed.length)) {
        const saved = view.events.findLast(event => event.key === key)

        if (saved) {
          notify({ event: saved })
        }

        return {
          project: view.id,
          revision: view.revision,
          skipped: 'unchanged',
        }
      }

      const event: ProjectMemoryEvent = {
        v: 1,
        id: meta.id ?? randomUUID(),
        seq: view.revision + 1,
        at: meta.at,
        actor: meta.actor,
        ...(meta.reason ? { reason: meta.reason } : {}),
        hydra: hydraId,
        identity: view.identity,
        key,
        before,
        after,
        ...(key === 'profile' && after !== null ? { sources: view.currentSources.hashes } : {}),
      }

      if (confirmed !== undefined) {
        event.confirmed = confirmed
      }

      if (learning) {
        event.learning = learning
      }

      const dir = join(
        pnyxHome(),
        'projects',
        view.id,
      )
      privateDir({ dir })
      appendFileSync(
        memoryPath(view),
        `${JSON.stringify(event)}\n`,
        { mode: 0o600 },
      )

      notify({ event })

      return {
        project: view.id,
        revision: event.seq,
        key,
        event: after === null ? 'forgotten' : 'saved',
        used: `${used} of ${PROJECT_MEMORY_BUDGET} characters`,
      }
    },
  })
}

export function checkProjectMemoryBudget({
  memory,
  key,
  after,
}: {
  memory: ProjectMemory
  key: ProjectMemoryKey
  after: string | null
}): number {
  const current = projectMemorySize(memory)
  const used = current - (memory.documents[key]?.length ?? 0) + (after?.length ?? 0)

  if (after !== null && used > PROJECT_MEMORY_BUDGET && used > current) {
    inform({
      reason: `Project memory uses ${used} of ${PROJECT_MEMORY_BUDGET} characters`,
      clear: `Use pnyx-axi project memory forget, or ${INSCRIBE_SKILL}, to curate it`,
    })
  }

  return used
}

function mergeImportedLearning({
  learnings,
  imported,
}: {
  learnings: Learning[]
  imported?: Learning
}): Learning[] {
  if (!imported) {
    return learnings
  }

  const existing = learnings.find(line => line.text === imported.text)

  if (existing && Date.parse(existing.at) >= Date.parse(imported.at)) {
    return learnings
  }

  return [
    ...learnings.filter(line => line.text !== imported.text),
    imported,
  ]
}

import { checkWorkerNotes, workerNotesNotice } from '../memory/workers.ts'
import { dateLearnings, type Learning } from '../memory/learnings.ts'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Meta } from '../core/decide.ts'
import { HydraError } from '../core/model.ts'
import { privateDir, withRegistryLock, withWriter } from '../store/hydra-store.ts'
import { pnyxHome } from '../store/paths.ts'
import { projectIdentity, projectSources } from './sources.ts'

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
  documents: Partial<Record<ProjectMemoryKey, string>>
  sources: Record<string, string>
  events: ProjectMemoryEvent[]
}

export const projectMemorySize = ({ documents }: Pick<ProjectMemory, 'documents'>) => Object.values(documents).reduce(
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

export function readProjectMemory({ id }: { id: string }): ProjectMemory {
  return withRegistryLock({ fn: () => readProjectMemoryLog({ id }) })
}

function readProjectMemoryLog({ id }: { id: string }): ProjectMemory {
  const file = memoryPath({ id })
  const memory: ProjectMemory = {
    revision: 0,
    documents: {},
    sources: {},
    events: [],
  }

  if (!existsSync(file)) {
    return memory
  }

  const text = readFileSync(
    file,
    'utf8',
  )

  if (text && !text.endsWith('\n')) {
    throw new HydraError({
      message: 'Project memory has an incomplete event; inspect its log before writing',
      code: 'LOG_CORRUPT',
    })
  }

  for (const line of text.split('\n').filter(Boolean)) {
    let event: ProjectMemoryEvent

    try {
      event = JSON.parse(line)
    } catch {
      throw new HydraError({
        message: 'Project memory contains an invalid event',
        code: 'LOG_CORRUPT',
      })
    }

    if (!event || typeof event !== 'object' || event.v !== 1 || event.seq !== memory.revision + 1 || !Object.hasOwn(
      PROJECT_MEMORY_DOCUMENTS,
      event.key,
    ) || (event.after !== null && typeof event.after !== 'string')) {
      throw new HydraError({
        message: 'Project memory contains an invalid event',
        code: 'LOG_CORRUPT',
      })
    }

    if (event.after === null) {
      delete memory.documents[event.key]
    } else {
      memory.documents[event.key] = event.after
    }

    if (event.key === 'learnings') {
      memory.learnings = dateLearnings({
        before: memory.learnings,
        after: event.after,
        at: event.at,
        confirmed: event.confirmed,
        evidence: event.reason,
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

export function projectMemoryView({ path }: { path: string }) {
  return withRegistryLock({ fn: () => projectMemoryViewUnderLock({ path }) })
}

export function projectMemoryViewUnderLock({ path }: { path: string }) {
  const identity = projectIdentity({ path })
  const memory = readProjectMemoryLog(identity)
  const sources = projectSources({ path })
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

export function writeProjectMemory({
  path,
  hydraId,
  key,
  after,
  sources,
  meta,
  confirmed,
}: {
  path: string
  hydraId: string
  key: ProjectMemoryKey
  after: string | null
  sources?: string
  meta: Meta
  confirmed?: string
}) {
  if (key === 'workers') {
    checkWorkerNotes({
      text: after,
      reason: meta.reason,
    })
  }

  return withRegistryLock({
    fn: () => {
      const view = projectMemoryViewUnderLock({ path })

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

      if (confirmed !== undefined) {
        after = before
      }

      const used = checkProjectMemoryBudget({
        memory: view,
        key,
        after,
      })

      if (confirmed !== undefined && key !== 'learnings') {
        throw new HydraError({
          message: 'Only learnings need reconfirmation',
          code: 'VALIDATION_ERROR',
        })
      }

      if (key === 'learnings') {
        dateLearnings({
          before: view.learnings,
          after,
          at: meta.at,
          confirmed,
          evidence: meta.reason,
        })
      }

      if (before === after && confirmed === undefined && (key !== 'profile' || !view.changed.length)) {
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
    throw new HydraError({
      message: `Project memory would use ${used} of ${PROJECT_MEMORY_BUDGET} characters`,
      code: 'MEMORY_FULL',
      help: ['Load inscribe: merge, shorten or forget project entries, then save again'],
    })
  }

  return used
}

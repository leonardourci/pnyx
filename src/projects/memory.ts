import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Meta } from '../core/decide.ts'
import { HydraError } from '../core/model.ts'
import { privateDir, withRegistryLock } from '../store/hydra-store.ts'
import { pnyxHome } from '../store/paths.ts'
import { projectIdentity, projectSources } from './sources.ts'

export const PROJECT_MEMORY_BUDGET = 3000
export const PROJECT_MEMORY_NEARLY_FULL = 0.8
export const PROJECT_MEMORY_DOCUMENTS = {
  profile: 'Profile',
  preferences: 'Project owner preferences',
  learnings: 'Project learnings',
} as const
export type ProjectMemoryKey = keyof typeof PROJECT_MEMORY_DOCUMENTS

interface MemoryEvent {
  v: 1
  id: string
  seq: number
  at: string
  actor: string
  reason?: string
  hydra: string
  identity: string
  key: ProjectMemoryKey
  before: string | null
  after: string | null
  sources?: Record<string, string>
}

export interface ProjectMemory {
  revision: number
  documents: Partial<Record<ProjectMemoryKey, string>>
  sources: Record<string, string>
  events: MemoryEvent[]
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
    let event: MemoryEvent

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
  const identity = projectIdentity({ path })
  const memory = readProjectMemory(identity)
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
}: {
  path: string
  hydraId: string
  key: ProjectMemoryKey
  after: string | null
  sources?: string
  meta: Meta
}) {
  return withRegistryLock({
    fn: () => {
      const view = projectMemoryView({ path })

      if (meta.id && view.events.some(event => event.id === meta.id)) {
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
      const used = view.used - (before?.length ?? 0) + (after?.length ?? 0)

      if (after !== null && used > PROJECT_MEMORY_BUDGET && used > view.used) {
        throw new HydraError({
          message: `Project memory would use ${used} of ${PROJECT_MEMORY_BUDGET} characters`,
          code: 'MEMORY_FULL',
          help: ['Load inscribe: merge, shorten or forget project entries, then save again'],
        })
      }

      if (before === after && (key !== 'profile' || !view.changed.length)) {
        return {
          project: view.id,
          revision: view.revision,
          skipped: 'unchanged',
        }
      }

      const event: MemoryEvent = {
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

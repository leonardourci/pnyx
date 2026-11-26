import { existsSync } from 'node:fs'
import { ownerMemoryLogPath, readOwnerLogs } from '#memory/owner-memory-log.ts'
import { projectsFor } from '#projects/read.ts'

import { INSCRIBE_SKILL } from '#setup/skill-names.ts'
import { memoryConditions } from '#memory/conditions.ts'
import { matchesProject } from './identity.ts'
import { staleLearnings, learningDigest } from '#memory/learnings.ts'
import type { TitanState } from '#app/model.ts'
import type { TitanProject } from './model.ts'
import { projectMemoryLogPath, PROJECT_MEMORY_BUDGET, PROJECT_MEMORY_DOCUMENTS, PROJECT_MEMORY_NEARLY_FULL, readableProjectMemory } from '#memory/project-memory.ts'

const WORKER_DOCUMENT_LIMIT = 400

function fullMemory({
  id,
  identity,
}: {
  id: string
  identity: string
}): string {
  const paths = [...readOwnerLogs().keys()].map(polis => ownerMemoryLogPath({ polis }))
  const owners = paths.filter(existsSync)
  const projectLog = JSON.stringify(projectMemoryLogPath({ id }))
  const movedEvents = owners.length ? ` Read these owner memory logs too: ${JSON.stringify(owners)}. Include projectMove.event records whose project event identity is ${JSON.stringify(identity)}, including those inside nested polisMove.entry records.` : ''

  return `Read the project memory log at ${projectLog} if it exists.${movedEvents} Merge the project log events and matching moved events in ascending project event seq order. Set the document named by each event's key to its after value, or remove it when after is null.`
}

export async function projectDigest({
  titanId,
  readable,
}: {
  titanId: string
  readable: TitanProject[]
}): Promise<string[]> {
  const projects = readable.filter(project => !project.detached)

  if (!projects.length) {
    return []
  }

  const conditions = memoryConditions()
  const lines = await Promise.all(projects.map(async project => {
    const view = await readableProjectMemory({
      ...project,
      titanId,
    })

    if (!view) {
      return []
    }

    const stale = staleLearnings({
      lines: view.learnings ?? [],
      conditions,
      now: new Date().toISOString(),
    })
    const nearlyFull = view.used > PROJECT_MEMORY_BUDGET * PROJECT_MEMORY_NEARLY_FULL

    return [`- ${project.name} (${project.path}) · full memory: ${fullMemory(view)} · profile: ${view.status} · memory revision ${view.revision}${nearlyFull ? ` · nearly full: load ${INSCRIBE_SKILL} with this project` : ''}${stale.length ? ` · ${stale.length} stale learnings: load ${INSCRIBE_SKILL}` : ''}`]
  }))

  const summaries = lines.flat()

  if (summaries.length === 0) {
    return []
  }

  return [
    'Projects (replay the supplied records for full memory):',
    ...summaries,
  ]
}

export async function projectWorkerContext({
  titanId,
  state,
  project: ref,
}: {
  titanId: string
  state: TitanState
  project?: string
}): Promise<{
  context: string
  workers: string
}> {
  const empty = {
    context: '',
    workers: '',
  }
  const project = (projectsFor({ state })).filter(project => !project.detached)
    .find(project => matchesProject({
      project,
      ref,
    }))

  if (!project) {
    return empty
  }

  const view = await readableProjectMemory({
    ...project,
    titanId,
  })

  if (!view) {
    return empty
  }

  return {
    workers: view.documents.workers ?? '',
    context: [
      `Project ${project.name}: shared memory (${view.status}).`,
      ...Object.entries(PROJECT_MEMORY_DOCUMENTS).flatMap(([
        key,
        title,
      ]) => {
        if (key === 'workers') {
          return []
        }

        const document = key === 'learnings' && view.learnings?.length ? learningDigest({
          lines: view.learnings,
          conditions: memoryConditions(),
          now: new Date().toISOString(),
        }) : view.documents[key as keyof typeof PROJECT_MEMORY_DOCUMENTS]
        const text = document?.replace(
          /\s+/g,
          ' ',
        ).trim()

        return text ? [
          `${title}: ${text.length > WORKER_DOCUMENT_LIMIT ? `${text.slice(
            0,
            WORKER_DOCUMENT_LIMIT,
          )}…` : text}`,
        ] : []
      }),
      'Read the project conventions in your current copy before starting; the shared profile may need refreshing.',
      `Full memory: ${fullMemory(view)}`,
    ].join('\n'),
  }
}

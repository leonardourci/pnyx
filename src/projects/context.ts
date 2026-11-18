import { readableProjects } from '#memory/poleis.ts'
import { INSCRIBE_SKILL } from '#setup/skill-names.ts'
import { memoryConditions } from '#memory/conditions.ts'
import { matchesProject } from './identity.ts'
import { staleLearnings, learningDigest } from '#memory/learnings.ts'
import type { HydraState } from '#app/model.ts'
import { PROJECT_MEMORY_BUDGET, PROJECT_MEMORY_DOCUMENTS, PROJECT_MEMORY_NEARLY_FULL, readableProjectMemory } from '#memory/project-memory.ts'

const WORKER_DOCUMENT_LIMIT = 400

export async function projectDigest({
  state,
  hydraId,
}: {
  state: HydraState
  hydraId: string
}): Promise<string[]> {
  const projects = (await readableProjects({
    state,
    hydraId,
  })).filter(project => !project.detached)

  if (!projects.length) {
    return []
  }

  const conditions = memoryConditions()
  const lines = await Promise.all(projects.map(async project => {
    const view = await readableProjectMemory({
      ...project,
      hydraId,
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

    return [`- ${project.name} (${project.path}) · profile: ${view.status} · memory revision ${view.revision}${nearlyFull ? ` · nearly full: load ${INSCRIBE_SKILL} with this project` : ''}${stale.length ? ` · ${stale.length} stale learnings: load ${INSCRIBE_SKILL}` : ''}`]
  }))

  const summaries = lines.flat()

  if (summaries.length === 0) {
    return []
  }

  return [
    'Projects (load memory on demand with pnyx-axi project show <name|path>):',
    ...summaries,
  ]
}

export async function projectWorkerContext({
  hydraId,
  state,
  project: ref,
}: {
  hydraId: string
  state: HydraState
  project?: string
}): Promise<string> {
  const project = (await readableProjects({
    state,
    hydraId,
  })).filter(project => !project.detached)
    .find(project => matchesProject({
      project,
      ref,
    }))

  if (!project) {
    return ''
  }

  const view = await readableProjectMemory({
    ...project,
    hydraId,
  })

  if (!view) {
    return ''
  }

  return [
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
    `Full memory: pnyx-axi project show ${JSON.stringify(project.path)} --hydra ${hydraId}.`,
  ].join('\n')
}

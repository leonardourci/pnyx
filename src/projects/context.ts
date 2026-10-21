import type { HydraState } from '../core/model.ts'
import { projectsFor } from './read.ts'
import { PROJECT_MEMORY_BUDGET, PROJECT_MEMORY_DOCUMENTS, PROJECT_MEMORY_NEARLY_FULL, projectMemoryView } from './memory.ts'

const WORKER_DOCUMENT_LIMIT = 400

export function projectDigest({ state }: { state: HydraState }): string[] {
  const projects = projectsFor({ state }).filter(project => !project.detached)

  if (!projects.length) {
    return []
  }

  return [
    'Projects (load memory on demand with pnyx-axi project show <name|path>):',
    ...projects.map(project => {
      const view = projectMemoryView(project)
      const nearlyFull = view.used > PROJECT_MEMORY_BUDGET * PROJECT_MEMORY_NEARLY_FULL

      return `- ${project.name} (${project.path}) · profile: ${view.status} · memory revision ${view.revision}${nearlyFull ? ' · nearly full: load inscribe with this project' : ''}`
    }),
  ]
}

export function projectWorkerContext({
  hydraId,
  state,
  project: ref,
}: {
  hydraId: string
  state: HydraState
  project?: string
}): string {
  const project = projectsFor({ state }).filter(project => !project.detached)
    .find(project => project.path === ref || project.name === ref)

  if (!project) {
    return ''
  }

  const view = projectMemoryView(project)

  return [
    `Project ${project.name}: shared memory (${view.status}).`,
    ...Object.entries(PROJECT_MEMORY_DOCUMENTS).flatMap(([
      key,
      title,
    ]) => {
      const text = view.documents[key as keyof typeof PROJECT_MEMORY_DOCUMENTS]?.replace(
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

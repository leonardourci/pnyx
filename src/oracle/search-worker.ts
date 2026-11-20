import { loadHydra } from '#app/store.ts'
import { readProjectMemory } from '#memory/project-memory.ts'
import { projectIdentity } from '#projects/sources.ts'
import { projectsFor } from '#projects/read.ts'
import { parentPort, workerData } from 'node:worker_threads'
import { HydraError } from '#store/errors.ts'
import type { SearchAnswer, SearchInput } from './search-background.ts'
import { search } from './search.ts'

const input: SearchInput = workerData

try {
  const state = loadHydra({ hydraId: input.hydraId }).state
  const projects = (projectsFor({ state })).filter(project => !project.detached)
  const memoryDocuments = (await Promise.all(projects.map(async project => {
    const { id } = await projectIdentity(project)
    const current = loadHydra({ hydraId: input.hydraId }).state
    const attached = projectsFor({ state: current }).some(candidate =>
      !candidate.detached && candidate.path === project.path)

    if (!attached) {
      return []
    }

    const memory = readProjectMemory({id})

    return Object.values(memory.documents).map(text => ({
      card: '$board',
      project: project.path,
      kind: 'note' as const,
      at: memory.events.at(-1)?.at ?? '',
      text: `${project.name}: ${text}`,
    }))
  }))).flat()
  parentPort?.postMessage({
    result: search({
      ...input,
      memoryDocuments,
    }),
  } satisfies SearchAnswer)
} catch (error) {
  parentPort?.postMessage({
    error: {
      message: error instanceof Error ? error.message : String(error),
      code: error instanceof HydraError ? error.code : 'UNKNOWN',
      help: error instanceof HydraError ? error.help : undefined,
    },
  } satisfies SearchAnswer)
}

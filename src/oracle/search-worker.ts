import { readableProjects } from '#memory/spaces.ts'
import { loadHydra } from '#app/store.ts'
import { projectMemoryView } from '#memory/project-memory.ts'
import { parentPort, workerData } from 'node:worker_threads'
import { HydraError } from '#store/errors.ts'
import type { SearchAnswer, SearchInput } from './search-background.ts'
import { search } from './search.ts'

const input: SearchInput = workerData

try {
  const state = loadHydra({ hydraId: input.hydraId }).state
  const projects = (await readableProjects({
    hydraId: input.hydraId,
    state,
  })).filter(project => !project.detached)
  const memoryDocuments = (await Promise.all(projects.map(async project => {
    const view = await projectMemoryView({
      ...project,
      hydraId: input.hydraId,
    })

    return Object.values(view.documents).map(text => ({
      card: '$board',
      project: project.path,
      kind: 'note' as const,
      at: view.events.at(-1)?.at ?? '',
      text: `${project.name}: ${text}`,
    }))
  }))).flat()
  parentPort?.postMessage({
    result: search({
      ...input,
      state,
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

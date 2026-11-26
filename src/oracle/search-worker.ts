import { readProjectMemory } from '#memory/project-memory.ts'
import { projectIdentity } from '#projects/sources.ts'
import { projectsFor } from '#projects/read.ts'
import { parentPort, workerData } from 'node:worker_threads'
import { TitanError } from '#store/errors.ts'
import type { SearchAnswer, SearchWork } from './search-background.ts'
import { search } from './search.ts'

const input: SearchWork = workerData

try {
  const state = input.state
  const projects = (projectsFor({ state })).filter(project => !project.detached)
  const memoryDocuments = (await Promise.all(projects.map(async project => {
    const { id } = await projectIdentity(project)
    const memory = readProjectMemory({id})

    return Object.values(memory.documents).map(text => ({
      card: '$all',
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
      code: error instanceof TitanError ? error.code : 'UNKNOWN',
      help: error instanceof TitanError ? error.help : undefined,
    },
  } satisfies SearchAnswer)
}

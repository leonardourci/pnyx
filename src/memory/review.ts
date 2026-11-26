import { projectsFor } from '#projects/read.ts'

import { learningDigest, staleLearnings } from './learnings.ts'
import { memoryConditions } from './conditions.ts'
import { ownerMemory } from './owner-memory.ts'
import { loadTitan } from '#app/store.ts'
import { readableProjectMemory } from './project-memory.ts'

export async function memoryReview({
  titanId,
  now,
}: {
  titanId: string
  now: string
}) {
  const state = loadTitan({ titanId }).state
  const conditions = memoryConditions()
  const attached = (projectsFor({ state })).filter(project => !project.detached)
  const projectLayers = await Promise.all(attached.map(async project => ({
    name: `Project ${project.name}`,
    lines: (await readableProjectMemory({
      path: project.path,
      titanId,
    }))?.learnings ?? [],
  })))
  const layers = [
    {
      name: 'Owner',
      lines: (await ownerMemory({})).learnings?.lines ?? [],
    },
    ...projectLayers,
  ]
  const lines = layers.flatMap(layer => {
    const lines = staleLearnings({
      lines: layer.lines,
      now,
      conditions,
    })

    return lines.length ? [
      `${layer.name} memory:`,
      learningDigest({
        lines,
        now,
        conditions,
      }),
    ] : []
  })

  return {
    lines,
  }
}

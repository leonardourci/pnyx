import { learningDigest, staleLearnings } from '../memory/learnings.ts'
import { memoryConditions } from '../memory/conditions.ts'
import { ownerMemory } from '../store/owner-memory.ts'
import type { HydraState } from '../core/model.ts'
import { projectsFor } from '../projects/read.ts'
import { readProjectMemory } from '../projects/memory.ts'
import { projectIdentity } from '../projects/sources.ts'

export function memoryReview({
  state,
  now,
}: {
  state: HydraState
  now: string
}): string[] {
  const conditions = memoryConditions()
  const layers = [
    {
      name: 'Owner',
      lines: ownerMemory().learnings?.lines ?? [],
    },
    ...projectsFor({ state }).filter(project => !project.detached)
      .map(project => ({
        name: `Project ${project.name}`,
        lines: readProjectMemory(projectIdentity(project)).learnings ?? [],
      })),
  ]

  return layers.flatMap(layer => {
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
}

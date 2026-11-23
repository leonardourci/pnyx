import type { HydraState } from '#app/model.ts'
import type { HydraProject } from './model.ts'

export function projectGroup({ project }: { project: HydraProject }) {
  return project.group ?? {
    id: project.path,
    name: project.name,
  }
}

export interface ProjectGroup {
  id: string
  title: string
}

export function projectGroups({ state }: { state: Pick<HydraState, 'projects'> }): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>([
    [
      'ideas',
      {
        id: 'ideas',
        title: 'Ideas',
      },
    ],
  ])

  for (const project of state.projects ?? []) {
    const group = projectGroup({ project })
    groups.set(
      group.id,
      {
        id: group.id,
        title: group.name,
      },
    )
  }

  return [...groups.values()]
}

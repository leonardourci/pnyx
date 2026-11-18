import type { HydraProject } from './model.ts'

export function projectGroup({ project }: { project: HydraProject }) {
  return project.group ?? {
    id: project.path,
    name: project.name,
  }
}

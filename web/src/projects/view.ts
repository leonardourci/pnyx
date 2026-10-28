export function projectTitle({ project }: { project: string }): string {
  return project.startsWith('/') ? project.split('/').filter(Boolean)
    .at(-1) ?? project : project
}

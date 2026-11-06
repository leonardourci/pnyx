import type { HydraProject } from '#projects/model.ts'
import type { FolderListing } from '#projects/folders.ts'
import { reference } from '#hydra/mentions.ts'
import type { MentionItem } from './mention-picker.tsx'

const CLONE_URL = /^(?:https?:\/\/|git@)\S+$/

// What the @ picker offers beyond this Hydra's own projects.
export function folderSuggestions({
  query,
  typed,
  attached,
  otherProjects,
  listing,
  typedPath,
}: {
  query: string
  typed: string
  attached: HydraProject[]
  otherProjects: {
    name: string
    path: string
    hydra: string
  }[]
  listing?: FolderListing
  typedPath: boolean
}): MentionItem[] {
  if (CLONE_URL.test(typed)) {
    const repository = typed.replace(
      /\.git$/,
      '',
    ).split(/[/:]/)
      .pop() || typed

    return [
      {
        key: `clone:${typed}`,
        kind: 'project',
        title: `Clone ${repository}`,
        detail: typed,
        icons: ['clone'],
        group: 'Folders',
        insert: typed,
        path: typed,
      },
    ]
  }

  // A typed path lists only what is under it; other Hydras' projects would match any path.
  const candidates = (typedPath ? [] : otherProjects).map(project => ({
    ...project,
    detail: `In ${project.hydra}`,
  }))
  const folders: FolderListing['recent'] = []

  if (listing) {
    folders.push(...listing.recent)
  }

  if (listing && typedPath) {
    folders.push(...listing.folders)
  }

  for (const folder of folders) {
    candidates.push({
      ...folder,
      hydra: '',
      detail: folder.path,
    })
  }

  const skip = new Set(attached.filter(project => !project.detached).map(project => project.path))
  const items: MentionItem[] = []

  for (const folder of candidates) {
    const matching = typedPath || !query || `${folder.name} ${folder.path}`.toLocaleLowerCase().includes(query)

    if (matching && !skip.has(folder.path)) {
      skip.add(folder.path)
      items.push({
        key: `folder:${folder.path}`,
        kind: 'project',
        title: folder.name,
        detail: folder.detail,
        group: 'Folders',
        insert: reference({
          kind: 'project',
          value: folder.path,
          label: folder.name,
        }),
        path: folder.path,
      })
    }
  }

  return items
}

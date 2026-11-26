import type { TitanProject } from '#projects/model.ts'
import type { Folder, FolderListing } from '#projects/folders.ts'
import { reference } from '#titan/mentions.ts'
import type { MentionItem } from './mention-picker.tsx'
import type { TypedListing } from './path-completion.ts'

export const CLONE_URL = /^(?:https?:\/\/|git@)\S+$/

const fileItem = ({
  name,
  path,
}: Folder): MentionItem => ({
  key: `file:${path}`,
  kind: 'file',
  title: name,
  detail: path,
  icons: ['file'],
  group: 'Files',
  insert: reference({
    kind: 'file',
    value: path,
    label: name,
  }),
})

// What the @ picker offers beyond this Titan's own projects.
export function folderSuggestions({
  typed,
  attached,
  otherProjects,
  listing,
  typedPath,
}: {
  typed: string
  attached: TitanProject[]
  otherProjects: {
    name: string
    path: string
    hydra: string
  }[]
  listing?: TypedListing
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

  // A typed path lists only what is under it; other Titans' projects would match any path.
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
    if (!skip.has(folder.path)) {
      skip.add(folder.path)
      items.push({
        key: `folder:${folder.path}`,
        kind: 'project',
        title: folder.name,
        detail: folder.detail,
        icons: ['project'],
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

  const files = typedPath ? (listing?.files ?? []).map(fileItem) : []

  return [
    ...items,
    ...files,
  ]
}

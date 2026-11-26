import type { TitanProject } from '#projects/model.ts'
import type { Folder, FolderListing } from '#projects/folders.ts'
import { hiddenUntilDotTyped, startsWithTyped } from '#projects/folder-names.ts'
import { reference } from '#titan/mentions.ts'
import type { MentionItem } from './mention-picker.tsx'

type TypedListing = Pick<FolderListing, 'folders' | 'files' | 'recent'> & { selected?: Folder }

export function splitPath({ path }: { path: string }) {
  const slash = path.lastIndexOf('/')

  if (slash < 0) {
    return {
      directory: path,
      name: '',
    }
  }

  return {
    directory: path.slice(
      0,
      slash + 1,
    ),
    name: path.slice(slash + 1),
  }
}

export function typedListing({
  listing,
  name,
}: {
  listing: FolderListing
  name: string
}): TypedListing {
  const shown = ({ name: entry }: Folder) => startsWithTyped({
    name: entry,
    typed: name,
  }) && !hiddenUntilDotTyped({
    name: entry,
    typed: name,
  })
  const namedFolder = listing.folders.find(folder => folder.name === name)

  return {
    folders: listing.folders.filter(shown),
    files: (listing.files ?? []).filter(shown),
    recent: listing.recent,
    selected: name ? namedFolder : listing.selected,
  }
}

export const CLONE_URL = /^(?:https?:\/\/|git@)\S+$/

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

  const files: MentionItem[] = typedPath ? (listing?.files ?? []).map(file => ({
    key: `file:${file.path}`,
    kind: 'file',
    title: file.name,
    detail: file.path,
    icons: ['file'],
    group: 'Files',
    insert: reference({
      kind: 'file',
      value: file.path,
      label: file.name,
    }),
  })) : []

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

  return [
    ...items,
    ...files,
  ]
}

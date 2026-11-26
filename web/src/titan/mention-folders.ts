import type { TitanProject } from '#projects/model.ts'
import type { Folder, FolderListing } from '#projects/folders.ts'
import { ENTRY_LIMIT } from '#projects/folder-limit.ts'
import { reference } from '#titan/mentions.ts'
import type { MentionItem } from './mention-picker.tsx'

// A typed path asks for its folder once; the name after the last slash only filters that listing.
export function splitPath({ path }: { path: string }) {
  const slash = path.lastIndexOf('/')

  return {
    directory: path.slice(
      0,
      slash + 1,
    ) || path,
    name: slash < 0 ? '' : path.slice(slash + 1),
  }
}

const shownFor = ({
  name,
  lower,
}: {
  name: string
  lower: string
}) => ({ name: entry }: Folder) => entry.toLowerCase().startsWith(lower) && (!entry.startsWith('.') || name.startsWith('.'))

// The folder's listing narrowed to the typed name as a prefix, as if the server had been asked for the whole path.
export function typedListing({
  listing,
  name,
}: {
  listing: FolderListing
  name: string
}): FolderListing {
  const shown = shownFor({
    name,
    lower: name.toLowerCase(),
  })
  const exact = name ? listing.folders.find(folder => folder.name === name) : undefined
  // A capped listing may leave out matches, so it completes nothing.
  const complete = listing.folders.length < ENTRY_LIMIT
  const selected = name ? exact && {
    ...exact,
    empty: false,
  } : listing.selected

  return {
    folders: complete ? listing.folders.filter(shown) : [],
    files: (listing.files ?? []).filter(shown),
    recent: listing.recent,
    ...(selected ? { selected } : {}),
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
    group: 'Folders',
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

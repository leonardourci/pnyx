import type { FolderEntry, FolderListing } from '#projects/folders.ts'
import { CONTENTS_LIMIT, RECENT_LIMIT } from '#projects/folder-limit.ts'
import { hiddenUntilDotTyped, startsWithTyped } from '#projects/folder-names.ts'

export type TypedListing = Pick<FolderListing, 'folders' | 'files' | 'recent'> & { selected?: FolderEntry }

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
  const directory = listing.selected

  if (!directory) {
    return {
      folders: [],
      files: [],
      recent: listing.recent.slice(
        0,
        RECENT_LIMIT,
      ),
    }
  }

  const shown = ({ name: entry }: FolderEntry) => startsWithTyped({
    name: entry,
    typed: name,
  }) && !hiddenUntilDotTyped({
    name: entry,
    typed: name,
  })
  const typedFullPath = `${directory.path.replace(
    /\/$/,
    '',
  )}/${name}`
  const recentUnderTypedName = listing.recent.filter(folder => startsWithTyped({
    name: folder.path,
    typed: typedFullPath,
  }))
  const recent = name ? recentUnderTypedName : listing.recent
  const namedFolder = listing.folders.find(folder => folder.name === name)

  return {
    folders: listing.folders.filter(shown),
    files: (listing.files ?? []).filter(shown),
    recent: recent.slice(
      0,
      RECENT_LIMIT,
    ),
    selected: name ? namedFolder : directory,
  }
}

const commonPrefix = ({ names }: { names: string[] }) => names.reduce((
  prefix,
  name,
) => {
  let length = 0

  while (length < prefix.length && prefix[length] === name[length]) {
    length += 1
  }

  return prefix.slice(
    0,
    length,
  )
})

// Shell-style Tab on a typed folder path: the completed text, or undefined when Tab has nothing to add.
// A path naming an existing folder is complete; the next Tab commits it instead.
export function completePath({
  typed,
  contents,
}: {
  typed: string
  contents: FolderListing
}): string | undefined {
  const foldersLeftOut = contents.folders.length >= CONTENTS_LIMIT

  if (foldersLeftOut) {
    return undefined
  }

  const listing = typedListing({
    listing: contents,
    name: splitPath({ path: typed }).name,
  })

  if (listing.selected || !listing.folders.length) {
    return undefined
  }

  const parent = typed.slice(
    0,
    typed.lastIndexOf('/') + 1,
  )
  const names = listing.folders.map(folder => folder.name)
  const completed = names.length === 1 ? `${parent}${names[0]}/` : `${parent}${commonPrefix({ names })}`

  return completed.length > typed.length ? completed : undefined
}

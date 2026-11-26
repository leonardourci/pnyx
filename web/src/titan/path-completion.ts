import type { Folder, FolderListing } from '#projects/folders.ts'
import { CONTENTS_LIMIT } from '#projects/folder-limit.ts'
import { hiddenUntilDotTyped, startsWithTyped } from '#projects/folder-names.ts'

export type TypedListing = Pick<FolderListing, 'folders' | 'files' | 'recent'> & { selected?: Folder }

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
  // A full listing may leave out matches, so their common prefix could complete too far.
  if (contents.folders.length >= CONTENTS_LIMIT) {
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

import type { FolderListing } from '#projects/folders.ts'

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
  listing,
}: {
  typed: string
  listing: FolderListing
}): string | undefined {
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

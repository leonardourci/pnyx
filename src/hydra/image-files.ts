import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import { ATTACHMENT_NAME, MAX_IMAGE_BYTES, imageType } from './images.ts'

const resolved = ({ path }: { path: string }) => {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

const inside = ({
  path,
  root,
}: {
  path: string
  root: string
}) => path.startsWith(root + sep)

// The image files a Hydra's page may load: its stored attachments and images inside its task copies.
// A link or `..` that leads outside the folder, another file type, an oversized or a missing file is refused.
export function hydraImageFile({
  dir,
  route,
}: {
  dir: string
  route: string
}) {
  let parts: string[]

  try {
    parts = route.split('/').map(decodeURIComponent)
  } catch {
    return undefined
  }

  const [
    folder,
    ...rest
  ] = parts
  const attachment = folder === 'attachments' && rest.length === 1 && ATTACHMENT_NAME.test(rest[0]!)
  const copied = folder === 'copies' && rest.length > 0
  const home = attachment || copied ? resolved({ path: dir }) : undefined

  if (!home) {
    return undefined
  }

  const root = join(
    home,
    folder!,
  )
  const rootStat = lstatSync(
    root,
    { throwIfNoEntry: false },
  )
  const path = join(
    root,
    ...rest,
  )
  const type = imageType({ path })

  // The folder must be the Hydra's own directory, never a link that would make another place trusted.
  if (!rootStat?.isDirectory() || !inside({
    path,
    root,
  }) || !type) {
    return undefined
  }

  // Nonblocking, so a FIFO named like an image answers at once and the file check below refuses it.
  let fd: number

  try {
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    )
  } catch {
    return undefined
  }

  try {
    const opened = fstatSync(fd)

    if (!opened.isFile() || opened.size > MAX_IMAGE_BYTES) {
      return undefined
    }

    // Checked after opening: a parent folder swapped for a link elsewhere makes the path resolve outside,
    // or to a different file than the one opened.
    const real = resolved({ path })
    const current = real ? statSync(
      real,
      { throwIfNoEntry: false },
    ) : undefined
    const same = current?.dev === opened.dev && current.ino === opened.ino

    if (!real || !inside({
      path: real,
      root,
    }) || !same) {
      return undefined
    }

    return {
      body: readFileSync(fd),
      type,
      stored: attachment,
    }
  } finally {
    closeSync(fd)
  }
}

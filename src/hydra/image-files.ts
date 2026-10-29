import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { join, sep } from 'node:path'
import { ATTACHMENT_NAME, MAX_IMAGE_BYTES, imageType } from './images.ts'

const resolved = ({ path }: { path: string }) => {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

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
  const root = attachment || copied ? resolved({
    path: join(
      dir,
      folder!,
    ),
  }) : undefined
  const file = root && resolved({
    path: join(
      root,
      ...rest,
    ),
  })
  const type = file && imageType({ path: file })

  if (!root || !file?.startsWith(root + sep) || !type) {
    return undefined
  }

  // One open file is checked and read, so a swap after the path check cannot change what is served.
  let fd: number

  try {
    fd = openSync(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    )
  } catch {
    return undefined
  }

  try {
    const stat = fstatSync(fd)

    if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) {
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

import { realpathSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import { ATTACHMENT_NAME, MAX_IMAGE_BYTES, imageType } from './images.ts'

// The image files a Hydra's page may load: its stored attachments and images inside its task copies.
// A link or `..` that leads outside the folder, another file type or an oversized file is refused.
export function hydraImageFile({
  dir,
  route,
}: {
  dir: string
  route: string
}) {
  const [
    folder,
    ...parts
  ] = route.split('/').map(decodeURIComponent)
  const attachment = folder === 'attachments' && parts.length === 1 && ATTACHMENT_NAME.test(parts[0]!)
  const copied = folder === 'copies' && parts.length > 0

  if (!attachment && !copied) {
    return undefined
  }

  const root = realpathSync(join(
    dir,
    folder!,
  ))
  const file = realpathSync(join(
    root,
    ...parts,
  ))
  const type = imageType({ path: file })
  const stat = statSync(file)

  if (!file.startsWith(root + sep) || !type || !stat.isFile() || stat.size > MAX_IMAGE_BYTES) {
    return undefined
  }

  return {
    file,
    type,
    stored: attachment,
  }
}

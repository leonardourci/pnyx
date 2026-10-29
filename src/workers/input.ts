import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { HostedImage } from './provider.ts'

export function imageBytes({ image }: { image: HostedImage }): Buffer {
  const bytes = readFileSync(image.path)
  const digest = createHash('sha256').update(bytes)
    .digest('hex')

  if (digest !== image.digest) {
    throw new Error(`The attached image changed before delivery: ${image.path}`)
  }

  return bytes
}

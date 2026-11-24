import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { attachedImages, imageType } from '#titan/images.ts'
import { TitanError } from '#store/errors.ts'
import type { HostedInput } from '#workers/provider.ts'

export function agentInput({
  id,
  text,
  original,
  hydras,
  ownerMessageId,
}: {
  id: string
  text: string
  original: string
  hydras: string[]
  ownerMessageId?: string
}): HostedInput {
  const images = attachedImages({
    text: original,
    hydras,
  }).map(path => {
    const mediaType = imageType({ path })

    if (!mediaType) {
      throw new TitanError({
        code: 'INVALID_IMAGE',
        message: `Unsupported image: ${path}`,
      })
    }

    try {
      const bytes = readFileSync(path)
      const digest = createHash('sha256').update(bytes)
        .digest('hex')

      return {
        path,
        mediaType,
        digest,
      }
    } catch (error) {
      throw new TitanError({
        code: 'INVALID_IMAGE',
        message: `Could not read attached image ${path}: ${(error as Error).message}`,
      })
    }
  })

  return {
    id,
    text,
    images,
    ownerMessageId,
  }
}

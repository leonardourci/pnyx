import { createHash, type UUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { HostedImage } from './provider.ts'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function ownerInputUuid({ id }: { id: string }): UUID {
  if (UUID_PATTERN.test(id)) {
    return id as UUID
  }

  const bytes = createHash('sha256').update(`pnyx-owner-input\0${id}`)
    .digest()
    .subarray(
      0,
      16,
    )
  bytes[6] = (bytes[6]! & 0x0f) | 0x80
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')

  return `${hex.slice(
    0,
    8,
  )}-${hex.slice(
    8,
    12,
  )}-${hex.slice(
    12,
    16,
  )}-${hex.slice(
    16,
    20,
  )}-${hex.slice(20)}`
}

export function imageBytes({ image }: { image: HostedImage }): Buffer {
  const bytes = readFileSync(image.path)
  const digest = createHash('sha256').update(bytes)
    .digest('hex')

  if (digest !== image.digest) {
    throw new Error(`The attached image changed before delivery: ${image.path}`)
  }

  return bytes
}

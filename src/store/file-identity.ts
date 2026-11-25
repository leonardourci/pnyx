import type { Stats } from 'node:fs'

export const fileIdentity = ({ stat }: { stat: Stats }) => String(stat.ino)

export function sameFile({
  known,
  identity,
}: {
  known: string
  identity: string
}): boolean {
  const savedWithDevice = known.endsWith(`:${identity}`)

  return known === identity || savedWithDevice
}

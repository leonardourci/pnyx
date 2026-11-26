import type { Stats } from 'node:fs'

export const fileIdentity = ({ stat }: { stat: Stats }) => String(stat.ino)

export function sameFile({
  saved,
  identity,
}: {
  saved: string
  identity: string
}): boolean {
  const savedWithDevice = saved.endsWith(`:${identity}`)

  return saved === identity || savedWithDevice
}

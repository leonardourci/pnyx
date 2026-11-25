import type { Stats } from 'node:fs'

// The inode alone names a file: macOS numbers a disk again at each mount, so its device changes across a reboot.
export const fileIdentity = ({ stat }: { stat: Stats }) => String(stat.ino)

// Positions saved before named the file `<device>:<inode>`.
export function sameFile({
  known,
  identity,
}: {
  known: string
  identity: string
}): boolean {
  return known === identity || known.endsWith(`:${identity}`)
}

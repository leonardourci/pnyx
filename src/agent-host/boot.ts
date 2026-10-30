import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const READ_TIMEOUT_MS = 1000
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i

export function kernelBootIdentity(): string | undefined {
  try {
    let identity: string

    if (process.platform === 'darwin') {
      identity = execFileSync(
        '/usr/sbin/sysctl',
        [
          '-n',
          'kern.bootsessionuuid',
        ],
        {
          encoding: 'utf8',
          timeout: READ_TIMEOUT_MS,
        },
      ).trim()
    } else if (process.platform === 'linux') {
      identity = readFileSync(
        '/proc/sys/kernel/random/boot_id',
        'utf8',
      ).trim()
    } else {
      return undefined
    }

    return UUID.test(identity) ? identity.toLowerCase() : undefined
  } catch {
    // An unreadable boot identity uses best-effort process cleanup instead.
    return undefined
  }
}

export function verifiedBootChange({
  before,
  after,
}: {
  before?: string
  after?: string
}): boolean {
  return typeof before === 'string' && typeof after === 'string'
    && UUID.test(before) && UUID.test(after) && before.toLowerCase() !== after.toLowerCase()
}

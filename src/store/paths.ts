import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function pnyxHome(): string {
  return process.env.PNYX_HOME || join(
    homedir(),
    '.pnyx',
  )
}

export function canonical({ path }: { path: unknown }): string | undefined {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    return undefined
  }

  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { HydraError } from '../core/model.ts'

export function pnyxHome(): string {
  return process.env.PNYX_HOME || join(homedir(), '.pnyx')
}

export function hydraDir({ hydraId }: { hydraId: string }): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(hydraId)) {
    throw new HydraError({
      message: `invalid Hydra name: ${hydraId}`,
      code: 'VALIDATION_ERROR',
      help: [
        'Use letters, digits, dot, dash or underscore',
      ],
    })
  }

  return join(pnyxHome(), 'boards', hydraId)
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

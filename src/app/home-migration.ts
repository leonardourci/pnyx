import { nativeHydraIds, readNativeHydra } from './native-read.ts'
import { join } from 'node:path'
import { HYDRA_ID } from '#hydra/identity.ts'
import { HydraError } from '#store/errors.ts'
import { pnyxHome } from '#store/paths.ts'
import { openedNativeHome } from './native-home.ts'

export const DEFAULT_HYDRA = 'default'

export const hydrasDir = (): string => join(
  pnyxHome(),
  'hydras',
)

export function hydraIds({
  includeRemoved = false,
}: {
  migrate?: boolean
  includeRemoved?: boolean
} = {}): string[] {
  const home = openedNativeHome()
  const ids = home ? home.files.hydras().sort() : nativeHydraIds()

  if (includeRemoved) {
    return ids
  }

  return ids.filter(id => {
    try {
      const state = home ? home.read({ hydra: id }).state : readNativeHydra({ hydraId: id }).state

      return !state.config?.removed
    } catch (error) {
      if (!(error instanceof HydraError)) {
        throw error
      }

      return true
    }
  })
}

export function hydraDir({
  hydraId,
}: {
  hydraId: string
  migrate?: boolean
}): string {
  if (!HYDRA_ID.test(hydraId)) {
    throw new HydraError({
      message: `invalid Hydra name: ${hydraId}`,
      code: 'VALIDATION_ERROR',
      help: ['Use letters, digits, dot, dash or underscore'],
    })
  }

  return join(
    hydrasDir(),
    hydraId,
  )
}

export const hydraAgentFolder = ({ hydraId }: { hydraId: string }): string => join(
  hydraDir({ hydraId }),
  'agent',
)

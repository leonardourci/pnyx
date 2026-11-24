import { nativeTitanIds, readNativeTitan } from './native-read.ts'
import { join } from 'node:path'
import { TITAN_ID } from '#titan/identity.ts'
import { TitanError } from '#store/errors.ts'
import { othrysHome } from '#store/paths.ts'
import { openedNativeHome } from './native-home.ts'

export const DEFAULT_TITAN = 'default'

export const hydrasDir = (): string => join(
  othrysHome(),
  'hydras',
)

export function hydraIds({
  includeRemoved = false,
}: {
  migrate?: boolean
  includeRemoved?: boolean
} = {}): string[] {
  const home = openedNativeHome()
  const ids = home ? home.files.hydras().sort() : nativeTitanIds()

  if (includeRemoved) {
    return ids
  }

  return ids.filter(id => {
    try {
      const state = home ? home.read({ hydra: id }).state : readNativeTitan({ hydraId: id }).state

      return !state.config?.removed
    } catch (error) {
      if (!(error instanceof TitanError)) {
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
  if (!TITAN_ID.test(hydraId)) {
    throw new TitanError({
      message: `invalid Titan name: ${hydraId}`,
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

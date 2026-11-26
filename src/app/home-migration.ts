import { nativeTitanIds, readNativeTitan } from './native-read.ts'
import { join } from 'node:path'
import { TITAN_ID } from '#titan/identity.ts'
import { TitanError } from '#store/errors.ts'
import { othrysHome } from '#store/paths.ts'
import { openedNativeHome } from './native-home.ts'

export const DEFAULT_TITAN = 'default'

export const titansDir = (): string => join(
  othrysHome(),
  'titans',
)

export function titanIds({
  includeRemoved = false,
}: {
  migrate?: boolean
  includeRemoved?: boolean
} = {}): string[] {
  const home = openedNativeHome()
  const ids = home ? home.files.titans().sort() : nativeTitanIds()

  if (includeRemoved) {
    return ids
  }

  return ids.filter(id => {
    try {
      const state = home ? home.read({ titan: id }).state : readNativeTitan({ titanId: id }).state

      return !state.config?.removed
    } catch (error) {
      if (!(error instanceof TitanError)) {
        throw error
      }

      return true
    }
  })
}

export function titanDir({
  titanId,
}: {
  titanId: string
  migrate?: boolean
}): string {
  if (!TITAN_ID.test(titanId)) {
    throw new TitanError({
      message: `invalid Titan name: ${titanId}`,
      code: 'VALIDATION_ERROR',
      help: ['Use letters, digits, dot, dash or underscore'],
    })
  }

  return join(
    titansDir(),
    titanId,
  )
}

export const titanAgentFolder = ({ titanId }: { titanId: string }): string => join(
  titanDir({ titanId }),
  'agent',
)

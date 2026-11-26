import { useMemo } from 'react'
import type { Catalog } from '#titan/transcripts-catalog.ts'
import type { Command } from '#web-app/connection.ts'
import { TITAN_CARD } from '#titan/identity.ts'
import { withBuiltInSkills } from '#titan/built-in-skills.ts'
import { useCachedList } from '#web-shared/cached-list.ts'
import { storageKey } from './outbox.ts'

const UNAVAILABLE_CATALOG: Catalog = {
  suggestions: [],
  unavailable: 'Commands unavailable. Close and reopen to retry.',
}

const validCatalog = ({ value }: { value: unknown }) => {
  const suggestions = (value as Partial<Catalog>).suggestions

  return Array.isArray(suggestions) && suggestions.every(item =>
    typeof item?.command === 'string' && typeof item.description === 'string' && typeof item.source === 'string')
}

export function useSkillsCatalog({
  identity,
  card,
  command,
  connected,
  open,
  provider,
}: {
  identity: string
  card: string
  command: Command
  connected: boolean
  open: boolean
  // Sets the skill prefix until the server's catalog arrives with its own provider.
  provider?: string
}): Catalog | null {
  const list = useCachedList<Catalog>({
    key: storageKey({ key: `skills:${identity}` }),
    connected,
    open,
    fetch: async () => (await command({
      name: 'catalog',
      args: [card],
    })).catalog as Catalog,
    savedCopyValid: validCatalog,
  })
  const failed = list.error !== undefined
  const catalog = list.value ?? (failed ? UNAVAILABLE_CATALOG : undefined)

  return useMemo(
    () => {
      if (!catalog && card !== TITAN_CARD) {
        return null
      }

      return withBuiltInSkills({
        catalog: catalog ?? { suggestions: [] },
        card,
        provider: catalog?.provider ?? provider,
      })
    },
    [
      catalog,
      card,
      provider,
    ],
  )
}

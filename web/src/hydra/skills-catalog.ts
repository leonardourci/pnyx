import { useEffect, useState } from 'react'
import type { Catalog } from '../../../src/hydra/transcripts-catalog.ts'
import type { Command } from '../app/connection.ts'
import { storageKey } from './outbox.ts'

const catalogs = new Map<string, Catalog>()
const pending = new Map<string, Promise<Catalog>>()

function cachedCatalog({ scope }: { scope: string }): Catalog | null {
  const cached = catalogs.get(scope)

  if (cached) {
    return cached
  }

  try {
    const saved: Catalog | null = JSON.parse(sessionStorage.getItem(scope) ?? 'null')

    if (saved && Array.isArray(saved.suggestions) && saved.suggestions.every(item =>
      typeof item.command === 'string' && typeof item.description === 'string' && typeof item.source === 'string')) {
      catalogs.set(
        scope,
        saved,
      )

      return saved
    }
  } catch { /* Blocked or outdated storage falls back to discovery. */ }

  return null
}

async function refreshCatalog({
  scope,
  card,
  command,
}: {
  scope: string
  card: string
  command: Command
}): Promise<Catalog> {
  const existing = pending.get(scope)

  if (existing) {
    return existing
  }

  const read = async () => {
    const result = await command({
      name: 'catalog',
      args: [card],
    })
    const catalog = result.catalog as Catalog
    const cached = cachedCatalog({ scope })

    if (cached && JSON.stringify(cached) === JSON.stringify(catalog)) {
      return cached
    }

    catalogs.set(
      scope,
      catalog,
    )

    try {
      sessionStorage.setItem(
        scope,
        JSON.stringify(catalog),
      )
    } catch { /* The in-memory list remains available when storage is full or blocked. */ }

    return catalog
  }

  const request = read()
  pending.set(
    scope,
    request,
  )

  try {
    return await request
  } finally {
    pending.delete(scope)
  }
}

export function useSkillsCatalog({
  identity,
  card,
  command,
  connected,
  open,
}: {
  identity: string
  card: string
  command: Command
  connected: boolean
  open: boolean
}): Catalog | null {
  const scope = storageKey({ key: `skills:${identity}` })
  const [
    loaded,
    setLoaded,
  ] = useState<{
    scope: string
    catalog: Catalog
  } | null>(null)
  const cached = cachedCatalog({ scope })
  const catalog = cached ?? (loaded?.scope === scope ? loaded.catalog : null)

  useEffect(
    () => {
      if (!connected || (!open && cachedCatalog({ scope }))) {
        return
      }

      let cancelled = false

      const read = async () => {
        try {
          const catalog = await refreshCatalog({
            scope,
            card,
            command,
          })

          if (!cancelled) {
            setLoaded(previous => previous?.scope === scope && previous.catalog === catalog
              ? previous : {
                scope,
                catalog,
              })
          }
        } catch {
          if (!cancelled && !cachedCatalog({ scope })) {
            setLoaded({
              scope,
              catalog: {
                suggestions: [],
                unavailable: 'Commands unavailable. Close and reopen to retry.',
              },
            })
          }
        }
      }

      read()

      return () => {
        cancelled = true
      }
    },
    [
      scope,
      card,
      command,
      connected,
      open,
    ],
  )

  return catalog
}

import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { save, stored } from '#web-app/connection-storage.ts'
import { useStableActions } from './stable.ts'

export interface CachedList<T> {
  value?: T
  error?: string
  reloading: boolean
}

interface Entry {
  list: CachedList<unknown>
  listeners: Set<() => void>
  reading?: Promise<void>
}

const EMPTY: CachedList<never> = { reloading: false }
const entries = new Map<string, Entry>()

function entryFor({
  key,
  savedCopyValid,
}: {
  key: string
  savedCopyValid({ value }: { value: unknown }): boolean
}): Entry {
  const known = entries.get(key)

  if (known) {
    return known
  }

  const saved = stored<unknown>({
    key,
    fallback: undefined,
  })
  const entry: Entry = {
    list: saved !== undefined && savedCopyValid({ value: saved }) ? {
      value: saved,
      reloading: false,
    } : EMPTY,
    listeners: new Set(),
  }
  entries.set(
    key,
    entry,
  )

  return entry
}

function publish({
  key,
  entry,
  list,
}: {
  key: string
  entry: Entry
  list: CachedList<unknown>
}) {
  const changed = list.value !== entry.list.value

  entry.list = list

  if (changed) {
    save({
      key,
      value: list.value,
    })
  }

  for (const listener of entry.listeners) {
    listener()
  }
}

function read<T>({
  key,
  entry,
  fetch,
  refresh,
}: {
  key: string
  entry: Entry
  fetch({ refresh }: { refresh: boolean }): Promise<T>
  refresh: boolean
}): void {
  if (entry.reading && !refresh) {
    return
  }

  const previous = entry.reading ?? Promise.resolve()
  const reading = previous.then(async () => {
    if (refresh) {
      publish({
        key,
        entry,
        list: {
          ...entry.list,
          reloading: true,
        },
      })
    }

    try {
      const next = await fetch({ refresh })
      const same = JSON.stringify(next) === JSON.stringify(entry.list.value)
      publish({
        key,
        entry,
        list: {
          value: same ? entry.list.value : next,
          reloading: false,
        },
      })
    } catch (error) {
      publish({
        key,
        entry,
        list: {
          ...entry.list,
          error: (error as Error).message,
          reloading: false,
        },
      })
    }
  }).finally(() => {
    if (entry.reading === reading) {
      entry.reading = undefined
    }
  })
  entry.reading = reading
}

export function useCachedList<T>({
  key,
  connected,
  open,
  fetch,
  savedCopyValid,
}: {
  key: string
  connected: boolean
  open: boolean
  fetch({ refresh }: { refresh: boolean }): Promise<T>
  savedCopyValid({ value }: { value: unknown }): boolean
}): CachedList<T> & { reload(): void } {
  const entry = entryFor({
    key,
    savedCopyValid,
  })
  const latest = useStableActions({ actions: { fetch } })
  const subscribe = useCallback(
    // eslint-disable-next-line othrys/object-params -- React owns the subscribe signature.
    (listener: () => void) => {
      entry.listeners.add(listener)

      return () => entry.listeners.delete(listener)
    },
    [entry],
  )
  const list = useSyncExternalStore(
    subscribe,
    () => entry.list,
  ) as CachedList<T>

  useEffect(
    () => {
      const wanted = open || entry.list.value === undefined

      if (connected && wanted) {
        read({
          key,
          entry,
          fetch: latest.fetch,
          refresh: false,
        })
      }
    },
    [
      key,
      entry,
      connected,
      open,
      latest,
    ],
  )

  return {
    ...list,
    reload: () => read({
      key,
      entry,
      fetch: latest.fetch,
      refresh: true,
    }),
  }
}

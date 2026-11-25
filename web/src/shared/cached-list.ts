import { useCallback, useEffect, useSyncExternalStore } from 'react'

// A list the page reads from the server: the copy it has shows at once, a read in the background replaces it only
// when the content differs, and a shown list is never cleared. Kept in memory and in sessionStorage per key.
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
  valid,
}: {
  key: string
  valid({ value }: { value: unknown }): boolean
}): Entry {
  const known = entries.get(key)

  if (known) {
    return known
  }

  const entry: Entry = {
    list: EMPTY,
    listeners: new Set(),
  }

  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null')

    if (saved !== null && valid({ value: saved })) {
      entry.list = {
        value: saved,
        reloading: false,
      }
    }
  } catch { /* Blocked or outdated storage reads from the server instead. */ }

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
    try {
      sessionStorage.setItem(
        key,
        JSON.stringify(list.value),
      )
    } catch { /* The list in memory stays usable when storage is full or blocked. */ }
  }

  for (const listener of entry.listeners) {
    listener()
  }
}

// One read per key at a time; a reload waits for a background read in flight and then asks again.
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
}): Promise<void> {
  if (entry.reading && !refresh) {
    return entry.reading
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

  return reading
}

// Reads in the background once connected when nothing is cached yet, and again each time `open` turns on;
// `reload` asks the source itself to look again.
export function useCachedList<T>({
  key,
  connected,
  open,
  fetch,
  valid,
}: {
  key: string
  connected: boolean
  open: boolean
  fetch({ refresh }: { refresh: boolean }): Promise<T>
  // Checks a copy saved by an older page before it is shown.
  valid({ value }: { value: unknown }): boolean
}): CachedList<T> & { reload(): void } {
  const entry = entryFor({
    key,
    valid,
  })
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
        void read({
          key,
          entry,
          fetch,
          refresh: false,
        })
      }
    },
    // A new fetch callback for the same key reads the same list.
    [
      key,
      entry,
      connected,
      open,
    ],
  )

  return {
    ...list,
    reload: () => void read({
      key,
      entry,
      fetch,
      refresh: true,
    }),
  }
}

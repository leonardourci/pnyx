import type { HydraEvent } from '../../../src/core/model.ts'
import { showsUpdate, tagsTask, type TaskEvent } from '../../../src/core/updates.ts'
import type { Command } from '../app/connection.ts'

const PAGE_SIZE = 50

interface Updates {
  events: TaskEvent[]
  more: boolean
  loaded: boolean
  // Something the list shows changed since the last read.
  stale: boolean
  error: string
}

const EMPTY: Updates = {
  events: [],
  more: false,
  loaded: false,
  stale: false,
  error: '',
}

// Kept per task for the whole tab, so reopening a card shows its list at once.
const entries = new Map<string, Updates>()
const listeners = new Set<() => void>()
const reads = new Map<string, Promise<void>>()
const again = new Set<string>()

const update = ({
  id,
  change,
}: {
  id: string
  change: Partial<Updates>
}) => {
  entries.set(
    id,
    {
      ...updatesOf({ id }),
      ...change,
    },
  )

  for (const listener of listeners) {
    listener()
  }
}

export const updatesOf = ({ id }: { id: string }): Updates => entries.get(id) ?? EMPTY

// eslint-disable-next-line pnyx/object-params -- useSyncExternalStore owns this signature.
export const subscribeUpdates = (listener: () => void) => {
  listeners.add(listener)

  return () => {
    listeners.delete(listener)
  }
}

const readPage = async ({
  command,
  id,
  before,
}: {
  command: Command
  id: string
  before?: number
}) => {
  const result = await command({
    name: 'history',
    args: [
      '--card',
      id,
      '--full',
      '--updates',
      '--limit',
      String(PAGE_SIZE),
      ...(before ? [
        '--before',
        String(before),
      ] : []),
    ],
  })
  const events = Array.isArray(result.events) ? result.events as TaskEvent[] : []

  return {
    events,
    // The server names the next page only when there is one.
    more: Array.isArray(result.help),
  }
}

const message = ({ error }: { error: unknown }) =>
  error instanceof Error ? error.message : String(error)

// Reads the newest page when the task has none or it went stale. One read per task runs at
// a time; a change that lands during it gets one more read after it, never a pile of them.
export function loadUpdates({
  command,
  id,
}: {
  command: Command
  id: string
}): Promise<void> {
  const running = reads.get(id)
  const current = updatesOf({ id })

  if (running) {
    if (current.stale) {
      again.add(id)
    }

    return running
  }

  if (current.loaded && !current.stale) {
    return Promise.resolve()
  }

  update({
    id,
    change: { stale: false },
  })
  const read = (async () => {
    try {
      const {
        events,
        more,
      } = await readPage({
        command,
        id,
      })
      const kept = updatesOf({ id })
      // A newest page sharing nothing with the kept list leaves a gap, so it starts over.
      const overlaps = events.some(next => kept.events.some(prior => prior.id === next.id))
      const fresh = !kept.loaded || (more && !overlaps)
      update({
        id,
        change: {
          events: fresh ? events : [
            ...events,
            ...kept.events.filter(event => !events.some(next => next.id === event.id)),
          ],
          more: fresh ? more : kept.more,
          loaded: true,
          error: '',
        },
      })
    } catch (error) {
      update({
        id,
        change: { error: message({ error }) },
      })
    } finally {
      reads.delete(id)

      if (again.delete(id)) {
        void loadUpdates({
          command,
          id,
        })
      }
    }
  })()
  reads.set(
    id,
    read,
  )

  return read
}

// A failed read leaves the list as it was, so Try again reads it once more.
export function retryUpdates({
  command,
  id,
}: {
  command: Command
  id: string
}): Promise<void> {
  update({
    id,
    change: { stale: true },
  })

  return loadUpdates({
    command,
    id,
  })
}

export async function loadOlderUpdates({
  command,
  id,
}: {
  command: Command
  id: string
}): Promise<void> {
  try {
    const {
      events,
      more,
    } = await readPage({
      command,
      id,
      before: Math.min(...updatesOf({ id }).events.map(event => event.seq)),
    })
    const kept = updatesOf({ id }).events
    update({
      id,
      change: {
        events: [
          ...kept,
          ...events.filter(event => !kept.some(prior => prior.id === event.id)),
        ],
        more,
        error: '',
      },
    })
  } catch (error) {
    update({
      id,
      change: { error: message({ error }) },
    })
  }
}

// Only an event the list would show marks a task's kept Updates stale; activity alone does not.
export function noteUpdate({ event }: { event: HydraEvent }) {
  for (const [
    id,
    entry,
  ] of entries) {
    if (!entry.stale && (event.cardId === id || tagsTask({
      event,
      ids: new Set([id]),
    })) && showsUpdate({ event })) {
      update({
        id,
        change: { stale: true },
      })
    }
  }
}

// A snapshot skips the events in between, so every kept list may be behind.
export function staleUpdates() {
  for (const [
    id,
    entry,
  ] of entries) {
    entries.set(
      id,
      {
        ...entry,
        stale: true,
      },
    )
  }

  for (const listener of listeners) {
    listener()
  }
}

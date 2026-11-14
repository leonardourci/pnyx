import type { TaskEvent } from '#tasks/updates.ts'

// The updates a card's tab holds: its newest events first, and the `before` that reads the page after the last one.
export interface UpdatesList {
  events: TaskEvent[]
  older?: number
}

// A list that ends carries no cursor at all.
const listOf = ({
  events,
  older,
}: {
  events: TaskEvent[]
  older?: number
}): UpdatesList => older === undefined ? { events } : {
  events,
  older,
}

export interface UpdatesRead {
  events: TaskEvent[]
  older?: number
}

// The newest page read again joins what the tab holds when it reaches back far enough to touch it, so the older pages
// stay; if events arrived past a whole page since, only the newest page is kept and older ones load again.
export function withNewest({
  list,
  read,
}: {
  list?: UpdatesList
  read: UpdatesRead
}): UpdatesList {
  const oldest = read.events.at(-1)?.seq

  if (!list || oldest === undefined || read.older === undefined) {
    return listOf({
      events: read.events,
      older: read.older,
    })
  }

  const newest = list.events[0]?.seq

  if (newest === undefined || newest < oldest) {
    return read
  }

  const kept = list.events.filter(event => event.seq < oldest)
  // Past the newest page, the list continues where it did before.
  const older = kept.length ? list.older : read.older

  return listOf({
    events: [
      ...read.events,
      ...kept,
    ],
    older,
  })
}

// An older page continues the list from its cursor.
export function withOlder({
  list,
  read,
}: {
  list: UpdatesList
  read: UpdatesRead
}): UpdatesList {
  const held = new Set(list.events.map(event => event.seq))

  return listOf({
    events: [
      ...list.events,
      ...read.events.filter(event => !held.has(event.seq)),
    ],
    older: read.older,
  })
}

import type { HydraEvent } from './model.ts'
import { homeScoped, query } from '#store/postgres.ts'
import { heldHydra } from './store.ts'

// The tasks an event belongs to, under which an index lists it.
type EventKeys = ({ event }: { event: HydraEvent }) => readonly string[]

type Index = Map<string, HydraEvent[]>

// ponytail: the server keeps every event it has read (65 MB of heap for a 45 MB log); query the events table per
// card if that is too much.
// through is the seq the events were read up to, which may pass the last one kept: an imported Hydra's last events
// can be agent transcript copies that stayed out of Postgres.
const read = new Map<string, {
  events: HydraEvent[]
  through: number
  indexes: Map<EventKeys, Index>
}>()

const addToIndex = ({
  index,
  keys,
  events,
}: {
  index: Index
  keys: EventKeys
  events: readonly HydraEvent[]
}) => {
  for (const event of events) {
    for (const key of keys({ event })) {
      const listed = index.get(key)

      if (listed) {
        listed.push(event)
      } else {
        index.set(
          key,
          [event],
        )
      }
    }
  }
}

const eventsAfter = ({
  hydraId,
  seq,
  through,
  limit,
}: {
  hydraId: string
  seq: number
  through?: number
  limit?: number
}): HydraEvent[] => (query({
  statements: [
    {
      text: `select data from events where hydra_id = $1 and seq > $2 and ($3::bigint is null or seq <= $3)
        order by seq limit $4`,
      values: [
        hydraId,
        seq,
        through ?? null,
        limit ?? null,
      ],
    },
  ],
})[0] as { data: HydraEvent }[]).map(row => row.data)

const extend = ({
  entry,
  events,
}: {
  entry: NonNullable<ReturnType<typeof read.get>>
  events: readonly HydraEvent[]
}) => {
  // Pushed one by one: a long tail would overflow a spread's argument limit.
  for (const event of events) {
    entry.events.push(event)
  }

  for (const [
    keys,
    index,
  ] of entry.indexes) {
    addToIndex({
      index,
      keys,
      events,
    })
  }
}

// The Hydra's events read so far, extended with the ones committed since. A held Hydra's own writes arrive through
// rememberEvents, so reading it needs no query while it is current. A read inside a write stops at the last commit,
// so the write's own events still arrive through rememberEvents once it commits.
function eventLog({ hydraId }: { hydraId: string }) {
  const key = homeScoped({ hydraId })
  let entry = read.get(key)

  if (!entry) {
    entry = {
      events: [],
      through: 0,
      indexes: new Map(),
    }
    read.set(
      key,
      entry,
    )
  }

  const held = heldHydra({ hydraId })?.committed

  if (held !== entry.through) {
    const events = eventsAfter({
      hydraId,
      seq: entry.through,
    })
    extend({
      entry,
      events,
    })
    const lastRead = events.at(-1)?.seq

    // A held Hydra is read up to its last commit; any other up to the last event the query found.
    if (held !== undefined) {
      entry.through = held
    } else if (lastRead !== undefined) {
      entry.through = lastRead
    }
  }

  return entry
}

// A committed write's events, so the reads that follow see them without a query.
export function rememberEvents({
  hydraId,
  from,
  events,
}: {
  hydraId: string
  from: number
  events: readonly HydraEvent[]
}): void {
  const entry = read.get(homeScoped({ hydraId }))

  if (entry?.through === from) {
    extend({
      entry,
      events,
    })
    // Only a write that appended events commits, so there is a last one.
    entry.through = events.at(-1)!.seq
  }
}

export function readEvents({ hydraId }: { hydraId: string }): HydraEvent[] {
  return eventLog({ hydraId }).events.slice()
}

// The events that `keys` lists under `key`, oldest first, without copying or scanning the rest of the log.
// A live view: the index is built on first use and grows with each later read, so it always matches the log.
export function indexedEvents({
  hydraId,
  keys,
  key,
}: {
  hydraId: string
  keys: EventKeys
  key: string
}): readonly HydraEvent[] {
  const log = eventLog({ hydraId })
  let index = log.indexes.get(keys)

  if (!index) {
    index = new Map()
    addToIndex({
      index,
      keys,
      events: log.events,
    })
    log.indexes.set(
      keys,
      index,
    )
  }

  return index.get(key) ?? []
}

// Events after seq `offset`, at most `limit` of them and none past seq `through`, and the seq of the last one read.
export function readEventsFrom({
  hydraId,
  offset,
  limit,
  through,
}: {
  hydraId: string
  offset: number
  limit?: number
  through?: number
}): {
  events: HydraEvent[]
  end: number
} {
  const events = eventsAfter({
    hydraId,
    seq: offset,
    through,
    limit,
  })

  return {
    events,
    end: events.at(-1)?.seq ?? offset,
  }
}

export function readInitialEvent({ hydraId }: { hydraId: string }): HydraEvent | null {
  const [rows] = query({
    statements: [
      {
        text: 'select data from events where hydra_id = $1 order by seq limit 1',
        values: [hydraId],
      },
    ],
  }) as { data: HydraEvent }[][]

  return rows?.[0]?.data ?? null
}

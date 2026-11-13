import type { HydraEvent } from './model.ts'
import { query } from '#store/postgres.ts'
import { heldHydra } from './store.ts'

// The tasks an event belongs to, under which an index lists it.
type EventKeys = ({ event }: { event: HydraEvent }) => readonly string[]

type Index = Map<string, HydraEvent[]>

// ponytail: the server keeps every event it has read (65 MB of heap for a 45 MB log); query the events table per
// card if that is too much.
const read = new Map<string, {
  events: HydraEvent[]
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
// rememberEvents, so reading it needs no query while it is current.
function eventLog({ hydraId }: { hydraId: string }) {
  let entry = read.get(hydraId)

  if (!entry) {
    entry = {
      events: [],
      indexes: new Map(),
    }
    read.set(
      hydraId,
      entry,
    )
  }

  const last = entry.events.at(-1)?.seq ?? 0

  if (heldHydra({ hydraId })?.state.seq !== last) {
    extend({
      entry,
      events: eventsAfter({
        hydraId,
        seq: last,
      }),
    })
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
  const entry = read.get(hydraId)

  if (entry && (entry.events.at(-1)?.seq ?? 0) === from) {
    extend({
      entry,
      events,
    })
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

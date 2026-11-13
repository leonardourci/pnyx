import type { HydraEvent } from './model.ts'
import { query } from '#store/postgres.ts'
import { hydraExists } from './store.ts'
import { hydraDir } from './home-migration.ts'
import { readLog } from './legacy-log.ts'

// The tasks an event belongs to, under which an index lists it.
type EventKeys = ({ event }: { event: HydraEvent }) => readonly string[]

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

export function readEvents({
  hydraId,
  cardId,
  types,
  after = 0,
  ids,
}: {
  hydraId: string
  cardId?: string
  types?: string[]
  after?: number
  ids?: string[]
}): HydraEvent[] {
  const [rows] = query({
    statements: [
      {
        text: `select data from events where hydra_id = $1 and seq > $2
      and ($3::text is null or card_id = $3 or type in ('hydra.message', 'task.session'))
      and ($4::text[] is null or type = any($4))
      and ($5::text[] is null or id = any($5)) order by seq`,
        values: [
          hydraId,
          after,
          cardId ?? null,
          types ?? null,
          ids ?? null,
        ],
      },
    ],
  }) as { data: HydraEvent }[][]

  return rows!.map(row => row.data)
}

// A Hydra's events, from its events.jsonl while it still waits to be imported, for the one-time moves of old values.
export function eventsOrLegacy({ hydraId }: { hydraId: string }): HydraEvent[] {
  if (hydraExists({ hydraId })) {
    return readEvents({ hydraId })
  }

  return readLog({ dir: hydraDir({ hydraId }) }).events
}

// Read candidates from Postgres, then apply the caller's task association rule.
export function indexedEvents({
  hydraId,
  keys,
  key,
  cardId = key,
}: {
  hydraId: string
  keys: EventKeys
  key: string
  cardId?: string
}): readonly HydraEvent[] {
  return readEvents({
    hydraId,
    cardId,
  }).filter(event => keys({ event }).includes(key))
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

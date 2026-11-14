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

export interface EventSelection {
  hydraId: string
  cardId?: string
  cardIds?: string[]
  types?: string[]
  after?: number
  before?: number
  ids?: string[]
  seqs?: number[]
  limit?: number
  descending?: boolean
  updates?: boolean
  // Only events at or after this time, and at or before that one.
  atFrom?: string
  atTo?: string
  // Only what shows in Hydra's chat as its own work: replies with text and the events Hydra itself wrote.
  hydraActions?: boolean
}

function eventSelection({
  hydraId,
  cardId,
  cardIds,
  types,
  after = 0,
  before,
  ids,
  seqs,
  updates = false,
  atFrom,
  atTo,
  hydraActions = false,
}: EventSelection) {
  const cards = cardIds ?? (cardId === undefined ? null : [cardId])

  return {
    where: `where hydra_id = $1 and seq > $2
      and ($3::text[] is null or $9::boolean or card_id = any($3)
        or (type = 'hydra.message' and (data->'data'->>'task' = any($3)
          or exists (select 1 from unnest($8::text[]) related(id)
            where strpos(coalesce(data->'data'->>'text', ''), related.id) > 0)))
        or (type = 'task.session' and
          (data->'data'->>'before' = any($3) or data->'data'->>'after' = any($3))))
      and ($4::text[] is null or type = any($4))
      and ($5::text[] is null or id = any($5))
      and ($6::bigint[] is null or seq = any($6))
      and ($7::bigint is null or seq < $7)
      and (not $9::boolean or exists (select 1 from card_updates updated
        where updated.hydra_id = events.hydra_id and updated.seq = events.seq
          and ($3::text[] is null or updated.card_id = any($3))))
      and ($10::text is null or at >= $10)
      and ($11::text is null or at <= $11)
      and (not $12::boolean or (type = 'card.replied' and coalesce(data->'data'->>'text', '') <> '')
        or (actor = 'hydra' and type <> 'hydra.message'))`,
    values: [
      hydraId,
      after,
      cards,
      types ?? null,
      ids ?? null,
      seqs ?? null,
      before ?? null,
      cards?.flatMap(id => [
        id,
        encodeURIComponent(id),
      ]) ?? null,
      updates,
      atFrom ?? null,
      atTo ?? null,
      hydraActions,
    ],
  }
}

export function readEvents({
  limit,
  descending = false,
  ...selection
}: EventSelection): HydraEvent[] {
  const {
    where,
    values,
  } = eventSelection(selection)
  const [rows] = query({
    statements: [
      {
        text: `select data from events ${where} order by seq ${descending ? 'desc' : 'asc'} limit $13`,
        values: [
          ...values,
          limit ?? null,
        ],
      },
    ],
  }) as { data: HydraEvent }[][]

  return rows!.map(row => row.data)
}

export function countEvents({ ...selection }: Omit<EventSelection, 'limit' | 'descending'>): number {
  const {
    where,
    values,
  } = eventSelection(selection)
  const [rows] = query({
    statements: [
      {
        text: `select count(*)::integer as count from events ${where}`,
        values,
      },
    ],
  })

  return Number(rows![0]!.count)
}

const EVENT_PAGE_SIZE = 200

// Scans that need old history retain only one bounded page, in either direction.
export function* scanEvents({ ...selection }: Omit<EventSelection, 'limit'>): Generator<HydraEvent> {
  let after = selection.after ?? 0
  let before = selection.before

  while (true) {
    const page = readEvents({
      ...selection,
      after,
      before,
      limit: EVENT_PAGE_SIZE,
    })

    if (!page.length) {
      return
    }

    yield* page

    if (selection.descending) {
      before = page.at(-1)!.seq
    } else {
      after = page.at(-1)!.seq
    }

    if (page.length < EVENT_PAGE_SIZE) {
      return
    }
  }
}

export function findEvent({
  matches,
  ...selection
}: Omit<EventSelection, 'limit'> & {
  matches({ event }: { event: HydraEvent }): boolean
}): HydraEvent | undefined {
  for (const event of scanEvents(selection)) {
    if (matches({ event })) {
      return event
    }
  }
}

// A Hydra's events, from its events.jsonl while it still waits to be imported, for the one-time moves of old values.
export function eventsOrLegacy({
  hydraId,
  types,
}: {
  hydraId: string
  types?: string[]
}): HydraEvent[] {
  if (hydraExists({ hydraId })) {
    return readEvents({
      hydraId,
      types,
    })
  }

  const events = readLog({ dir: hydraDir({ hydraId }) }).events

  return types ? events.filter(event => types.includes(event.type)) : events
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

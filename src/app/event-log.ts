import type { HydraEvent } from './model.ts'
import { query } from '#store/postgres.ts'
import { hydraExists } from './store.ts'
import { hydraDir } from './home-migration.ts'
import { readLog } from './legacy-log.ts'

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
}: EventSelection) {
  const cards = cardIds ?? (cardId === undefined ? null : [cardId])

  return {
    where: `where hydra_id = $1 and seq > $2
      and ($3::text[] is null or card_id = any($3)
        or (type = 'hydra.message' and (data->'data'->>'task' = any($3)
          or exists (select 1 from unnest($8::text[]) related(id)
            where strpos(coalesce(data->'data'->>'text', ''), related.id) > 0)))
        or (type = 'task.session' and
          (data->'data'->>'before' = any($3) or data->'data'->>'after' = any($3))))
      and ($4::text[] is null or type = any($4))
      and ($5::text[] is null or id = any($5))
      and ($6::bigint[] is null or seq = any($6))
      and ($7::bigint is null or seq < $7)
`,
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
        text: `select data from events ${where} order by seq ${descending ? 'desc' : 'asc'} limit $9`,
        values: [
          ...values,
          limit ?? null,
        ],
      },
    ],
  }) as { data: HydraEvent }[][]

  return rows!.map(row => row.data)
}

const EVENT_PAGE_SIZE = 200

// Scans that need old history retain only one bounded page, in either direction.
export function* scanEvents({ ...selection }: Omit<EventSelection, 'limit'>): Generator<HydraEvent> {
  const pageAt = ({ bounds }: { bounds: Pick<EventSelection, 'after' | 'before'> }) => readEvents({
    ...selection,
    ...bounds,
    limit: EVENT_PAGE_SIZE,
  })
  let page = pageAt({ bounds: {} })

  while (page.length) {
    yield* page

    if (page.length < EVENT_PAGE_SIZE) {
      return
    }

    const edge = page.at(-1)!.seq
    page = selection.descending
      ? pageAt({ bounds: { before: edge } })
      : pageAt({ bounds: { after: edge } })
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

const POSITION_BATCH = 500

// A native entry has a time but no log position: it takes the seq of the first event after its time, or the next seq when
// no event follows. The `at` index finds that event without reading every later one, and each statement covers a bounded
// batch of the distinct times.
export function eventPositions({
  hydraId,
  entries,
}: {
  hydraId: string
  entries: {
    id: string
    at?: string
  }[]
}): Map<string, number> {
  const valid = entries.filter(entry => Number.isFinite(Date.parse(entry.at ?? '')))
  const times = [...new Set(valid.map(entry => new Date(entry.at!).toISOString()))]
  const seqs = new Map<string, number>()

  for (let start = 0; start < times.length; start += POSITION_BATCH) {
    const batch = times.slice(
      start,
      start + POSITION_BATCH,
    )
    const [found] = query({
      statements: [
        {
          text: `select entry.at as at, coalesce((select min(seq) from events where hydra_id = $1 and at =
        (select min(at) from events where hydra_id = $1 and at > entry.at)),
      (select coalesce(max(seq), 0) + 1 from events where hydra_id = $1)) as seq
      from unnest($2::text[]) entry(at)`,
          values: [
            hydraId,
            batch,
          ],
        },
      ],
    }) as {
      at: string
      seq: number
    }[][]

    for (const row of found!) {
      seqs.set(
        row.at,
        Number(row.seq),
      )
    }
  }

  return new Map(valid.map(entry => [
    entry.id,
    seqs.get(new Date(entry.at!).toISOString())!,
  ]))
}

// When the log position, or the last position before it, was recorded; undefined before the first event.
export function eventTime({
  hydraId,
  seq,
}: {
  hydraId: string
  seq: number
}): string | undefined {
  const [rows] = query({
    statements: [
      {
        text: 'select at from events where hydra_id = $1 and seq <= $2 order by seq desc limit 1',
        values: [
          hydraId,
          seq,
        ],
      },
    ],
  }) as { at: string }[][]

  return rows![0]?.at
}

// The log positions a time bounds: the first event recorded at or after it and the last one at or before it. Event times
// are text, so the search is widened by a second to cover the two spellings of a time.
export function seqsAround({
  hydraId,
  time,
}: {
  hydraId: string
  time: number
}): {
  first: number
  last: number
} {
  const [rows] = query({
    statements: [
      {
        text: `select
        (select min(seq) from events where hydra_id = $1 and at =
          (select min(at) from events where hydra_id = $1 and at >= $2)) as first,
        (select max(seq) from events where hydra_id = $1 and at =
          (select max(at) from events where hydra_id = $1 and at <= $3)) as last`,
        values: [
          hydraId,
          new Date(time - 1000).toISOString(),
          new Date(time + 1000).toISOString(),
        ],
      },
    ],
  }) as {
    first: number | null
    last: number | null
  }[][]
  const [
    {
      first,
      last,
    },
  ] = rows!

  return {
    first: first === null ? Infinity : Number(first),
    last: last === null ? 0 : Number(last),
  }
}

// The log position of the event with this id.
export function eventSeq({
  hydraId,
  id,
}: {
  hydraId: string
  id: string
}): number | undefined {
  const [rows] = query({
    statements: [
      {
        text: 'select seq from events where hydra_id = $1 and id = $2',
        values: [
          hydraId,
          id,
        ],
      },
    ],
  }) as { seq: number }[][]

  return rows![0] && Number(rows![0].seq)
}

// The log position of a card's reply to the owner, by the reply's id.
export function replySeq({
  hydraId,
  card,
  reply,
}: {
  hydraId: string
  card: string
  reply: string
}): number | undefined {
  const [rows] = query({
    statements: [
      {
        text: `select seq from events where hydra_id = $1 and type = 'card.replied' and card_id = $2
          and data->'data'->>'reply' = $3 order by seq limit 1`,
        values: [
          hydraId,
          card,
          reply,
        ],
      },
    ],
  }) as { seq: number }[][]

  return rows![0] && Number(rows![0].seq)
}

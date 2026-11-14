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
  const [rows] = query({
    statements: [
      {
        text: `select coalesce((select min(seq) from events where hydra_id = $1 and at > entry.at),
      (select coalesce(max(seq), 0) + 1 from events where hydra_id = $1)) as seq
      from json_array_elements_text($2::json) with ordinality entry(at, position) order by position`,
        values: [
          hydraId,
          JSON.stringify(valid.map(entry => new Date(entry.at!).toISOString())),
        ],
      },
    ],
  }) as { seq: number }[][]

  return new Map(valid.map((
    entry,
    index,
  ) => [
    entry.id,
    Number(rows![index]!.seq),
  ]))
}

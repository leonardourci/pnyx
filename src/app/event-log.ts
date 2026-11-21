import { log } from './diagnostics.ts'
import type { HydraEvent } from './model.ts'
import { query } from '#store/postgres.ts'
import { heldHydra, hydraExists } from './store.ts'
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

const SLOW_READ_MS = 100

function selectedEvents({
  limit,
  descending = false,
  measured = true,
  ...selection
}: EventSelection & { measured?: boolean }): HydraEvent[] {
  const {
    where,
    values,
  } = eventSelection(selection)
  const started = performance.now()
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

  const ms = performance.now() - started

  if (measured) {
    log({
      operation: 'events.read',
      detailed: ms < SLOW_READ_MS,
      hydraId: selection.hydraId,
      taskId: selection.cardId,
      count: rows!.length,
      ms,
    })
  }

  return rows!.map(row => row.data)
}

export function readEvents({ ...selection }: EventSelection): HydraEvent[] {
  return selectedEvents(selection)
}

export function readChanges({ ...selection }: EventSelection): HydraEvent[] {
  const live = heldHydra({ hydraId: selection.hydraId })
  const milestones = live?.state.historyMilestones ?? []
  const receipts = milestones.flatMap(milestone => milestone.receipts ?? [])
  const recent = [
    ...live?.pending ?? [],
    ...live?.changes ?? [],
    ...receipts,
  ]
  let cards = selection.cardIds

  if (!cards && selection.cardId !== undefined) {
    cards = [selection.cardId]
  }

  const matches = recent.filter(event => {
    const withinRange = event.seq > (selection.after ?? 0)
      && (selection.before === undefined || event.seq < selection.before)

    if (!withinRange) {
      return false
    }

    if (selection.types && !selection.types.includes(event.type)) {
      return false
    }

    if (selection.ids && !selection.ids.includes(event.id)) {
      return false
    }

    if (selection.seqs && !selection.seqs.includes(event.seq)) {
      return false
    }

    if (!cards || cards.includes(event.cardId)) {
      return true
    }

    if (event.type === 'task.session') {
      return cards.includes(event.data.before ?? '') || cards.includes(event.data.after ?? '')
    }

    if (event.type !== 'hydra.message') {
      return false
    }

    return cards.includes(event.data.task ?? '') || cards.some(card =>
      event.data.text.includes(card) || event.data.text.includes(encodeURIComponent(card)))
  })
  const events = new Map(selectedEvents(selection).map(event => [
    event.seq,
    event,
  ]))

  for (const event of matches) {
    events.set(
      event.seq,
      event,
    )
  }

  const ordered = [...events.values()].sort((
    a,
    b,
  ) => selection.descending ? b.seq - a.seq : a.seq - b.seq)

  return ordered.slice(
    0,
    selection.limit,
  )
}

const EVENT_PAGE_SIZE = 200

// Scans that need old history retain only one bounded page, in either direction.
export function* scanEvents({ ...selection }: Omit<EventSelection, 'limit'>): Generator<HydraEvent> {
  const started = performance.now()
  let pages = 0
  let count = 0

  const pageAt = ({ bounds }: { bounds: Pick<EventSelection, 'after' | 'before'> }) => {
    pages += 1

    return selectedEvents({
      ...selection,
      ...bounds,
      limit: EVENT_PAGE_SIZE,
      measured: false,
    })
  }

  try {
    let page = pageAt({ bounds: {} })

    while (page.length) {
      count += page.length
      yield* page

      if (page.length < EVENT_PAGE_SIZE) {
        return
      }

      const edge = page.at(-1)!.seq
      page = selection.descending
        ? pageAt({ bounds: { before: edge } })
        : pageAt({ bounds: { after: edge } })
    }
  } finally {
    const ms = performance.now() - started
    log({
      operation: 'events.read',
      name: 'scan',
      hydraId: selection.hydraId,
      count,
      pages,
      ms,
      detailed: ms < SLOW_READ_MS,
    })
  }
}

export function* scanChanges({ ...selection }: Omit<EventSelection, 'limit'>): Generator<HydraEvent> {
  let bounds: Pick<EventSelection, 'after' | 'before'> = {}
  let page = readChanges({
    ...selection,
    ...bounds,
    limit: EVENT_PAGE_SIZE,
  })

  while (page.length) {
    yield* page

    if (page.length < EVENT_PAGE_SIZE) {
      return
    }

    const edge = page.at(-1)!.seq
    bounds = selection.descending ? { before: edge } : { after: edge }
    page = readChanges({
      ...selection,
      ...bounds,
      limit: EVENT_PAGE_SIZE,
    })
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

interface EventClock {
  seq: number
  at: string
  complete?: boolean
}

function observedTimes({ hydraId }: { hydraId: string }): EventClock[] {
  const live = heldHydra({ hydraId })

  if (!live) {
    return []
  }

  const milestones = live.state.historyMilestones ?? []
  const receipts = milestones.flatMap(milestone => milestone.receipts ?? [])
  const times: EventClock[] = [
    ...receipts,
    ...live.state.nativeTimes?.map(clock => ({
      ...clock,
      complete: true,
    })) ?? [],
  ]

  if (live.state.changedAt) {
    times.push({
      seq: live.state.seq,
      at: live.state.changedAt,
    })
  }

  return times.filter(clock => clock.seq <= live.state.seq)
}

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
  const observed = observedTimes({ hydraId }).sort((
    a,
    b,
  ) => a.at.localeCompare(b.at)
    || a.seq - b.seq || Number(!a.complete) - Number(!b.complete))
  const nextObserved = new Map<string, EventClock>()
  let position = 0

  for (const time of times.toSorted()) {
    while (position < observed.length) {
      const clock = observed[position]!

      if (clock.at > time || (clock.complete && clock.at === time)) {
        nextObserved.set(
          time,
          clock,
        )
        break
      }

      position++
    }
  }

  for (let start = 0; start < times.length; start += POSITION_BATCH) {
    const batch = times.slice(
      start,
      start + POSITION_BATCH,
    )
    const [found] = query({
      statements: [
        {
          text: `select entry.at as at,
        (select min(at) from events where hydra_id = $1 and at > entry.at) as next_at,
        coalesce((select min(seq) from events where hydra_id = $1 and at =
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
      next_at: string | null
      seq: number
    }[][]

    for (const row of found!) {
      const clock = nextObserved.get(row.at)
      let seq = Number(row.seq)

      if (clock && (row.next_at === null || clock.at < row.next_at
        || (clock.at === row.next_at && clock.seq < seq))) {
        seq = clock.seq
      } else if (row.next_at === null && !clock) {
        const current = heldHydra({ hydraId })?.state.seq ?? 0
        seq = Math.max(
          seq,
          current + 1,
        )
      }

      seqs.set(
        row.at,
        seq,
      )
    }
  }

  return new Map(valid.map(entry => [
    entry.id,
    seqs.get(new Date(entry.at!).toISOString())!,
  ]))
}

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
        text: 'select at, seq from events where hydra_id = $1 and seq <= $2 order by seq desc limit 1',
        values: [
          hydraId,
          seq,
        ],
      },
    ],
  }) as {
    at: string
    seq: number
  }[][]

  let latest = rows![0]

  for (const clock of observedTimes({ hydraId })) {
    if (clock.seq <= seq && (!latest || clock.seq > Number(latest.seq))) {
      latest = clock
    }
  }

  return latest?.at
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
  let firstSeq = first === null ? Infinity : Number(first)
  let lastSeq = last === null ? 0 : Number(last)

  for (const clock of observedTimes({ hydraId })) {
    const recordedAt = Date.parse(clock.at)

    if (recordedAt >= time - 1000) {
      firstSeq = Math.min(
        firstSeq,
        clock.seq,
      )
    }

    if (recordedAt <= time + 1000) {
      lastSeq = Math.max(
        lastSeq,
        clock.seq,
      )
    }
  }

  return {
    first: firstSeq,
    last: lastSeq,
  }
}

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

import { query } from '#store/postgres.ts'
import type { HydraEvent } from '#app/model.ts'
import { loadHydra } from '#app/store.ts'
import { HydraError } from '#store/errors.ts'
import { capItem } from '#store/size-cap.ts'
import { findCard } from './push-rules.ts'
import { UPDATES_MAX_PAGE, UPDATES_PAGE, type UpdatesPage } from './updates.ts'

// One page of a card's Updates, newest first, read from Postgres: the page asks for older ones as the owner scrolls.
export function taskUpdates({
  hydraId,
  ref,
  before,
  limit = UPDATES_PAGE,
}: {
  hydraId: string
  ref: string
  before?: number
  limit?: number
}): UpdatesPage {
  if (!Number.isInteger(limit) || limit < 1 || limit > UPDATES_MAX_PAGE) {
    throw new HydraError({
      message: `limit must be 1–${UPDATES_MAX_PAGE}`,
      code: 'VALIDATION_ERROR',
    })
  }

  if (before !== undefined && (!Number.isInteger(before) || before < 1)) {
    throw new HydraError({
      message: 'before must be an event seq',
      code: 'VALIDATION_ERROR',
    })
  }

  const task = findCard({
    state: loadHydra({ hydraId }).state,
    ref,
  })
  const read = readUpdateEvents({
    hydraId,
    cardId: task.id,
    before,
    limit: limit + 1,
  })
  const page = read.slice(
    0,
    limit,
  )

  const events = page.map(event => capItem({ value: event }))

  if (read.length > limit) {
    return {
      task: task.id,
      events,
      older: page.at(-1)!.seq,
    }
  }

  return {
    task: task.id,
    events,
  }
}

export function readUpdateEvents({
  hydraId,
  cardId,
  before,
  limit,
  types,
}: {
  types?: string[]
  hydraId: string
  cardId?: string
  before?: number
  limit: number
}): HydraEvent[] {
  const [rows] = query({
    statements: [
      {
        text: `select distinct on (updated.seq) events.data from card_updates updated join events
        on events.hydra_id = updated.hydra_id and events.seq = updated.seq
        where updated.hydra_id = $1 and ($2::text is null or updated.card_id = $2)
          and ($3::bigint is null or updated.seq < $3)
          and ($5::text[] is null or events.type = any($5))
        order by updated.seq desc limit $4`,
        values: [
          hydraId,
          cardId,
          before ?? null,
          limit,
          types ?? null,
        ],
      },
    ],
  }) as { data: HydraEvent }[][]
  const read = rows!.map(row => row.data)

  return read
}

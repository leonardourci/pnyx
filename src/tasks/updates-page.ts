import { readEvents } from '#app/event-log.ts'
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
  const read = readEvents({
    hydraId,
    cardId: task.id,
    updates: true,
    descending: true,
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

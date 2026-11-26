import { readEvents } from '#app/event-log.ts'
import type { TitanEvent } from '#app/model.ts'
import { loadTitan } from '#app/store.ts'
import { TitanError } from '#store/errors.ts'
import { capItem } from '#store/size-cap.ts'
import { findCard } from './push-rules.ts'
import { UPDATES_MAX_PAGE, UPDATES_PAGE, updateTasks, type UpdatesPage } from './updates.ts'

export function taskUpdates({
  titanId,
  ref,
  before,
  limit = UPDATES_PAGE,
}: {
  titanId: string
  ref: string
  before?: number
  limit?: number
}): UpdatesPage {
  if (!Number.isInteger(limit) || limit < 1 || limit > UPDATES_MAX_PAGE) {
    throw new TitanError({
      message: `limit must be 1–${UPDATES_MAX_PAGE}`,
      code: 'VALIDATION_ERROR',
    })
  }

  if (before !== undefined && (!Number.isInteger(before) || before < 1)) {
    throw new TitanError({
      message: 'before must be an event seq',
      code: 'VALIDATION_ERROR',
    })
  }

  const task = findCard({
    state: loadTitan({ titanId }).state,
    ref,
  })
  const read = readUpdateEvents({
    titanId,
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
  titanId,
  cardId,
  before,
  limit,
  types,
}: {
  types?: string[]
  titanId: string
  cardId?: string
  before?: number
  limit: number
}): TitanEvent[] {
  return readEvents({
    titanId,
    before,
    types,
    descending: true,
  })
    .filter(event => {
      const tasks = updateTasks({ event })

      return cardId === undefined ? tasks.length > 0 : tasks.includes(cardId)
    })
    .slice(
      0,
      limit,
    )
}

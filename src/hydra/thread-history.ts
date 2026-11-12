import { HydraError } from '#store/errors.ts'
import type { ThreadPage } from './transcripts-read.ts'
import { threadEntryOrder } from './thread-order.ts'

export const RECENT_THREAD_PAGES = 3
export const THREAD_PAGE_LIMIT = 60
export const RECENT_THREAD_ENTRIES = RECENT_THREAD_PAGES * THREAD_PAGE_LIMIT

export function threadSize({ page }: { page: ThreadPage }): number {
  return page.entries.filter(entry => !entry.id.startsWith('live:')).length
}

export function needsRecentThread({ page }: { page: ThreadPage }): boolean {
  return page.recent !== true && ((page.pages ?? 1) > RECENT_THREAD_PAGES
    || threadSize({ page }) > RECENT_THREAD_ENTRIES)
}

export async function recentThreadPages({
  page,
  read,
}: {
  page: ThreadPage
  read({ before }: { before: string }): ThreadPage | Promise<ThreadPage>
}): Promise<ThreadPage> {
  let recent = page
  const seen = new Set<string>()

  for (let count = 1; count < RECENT_THREAD_PAGES && recent.older; count++) {
    const cursor = recent.older

    if (seen.has(cursor)) {
      throw new HydraError({
        code: 'THREAD_HISTORY_STALLED',
        message: 'Earlier conversation pages did not advance.',
      })
    }

    seen.add(cursor)
    recent = mergeThreadPages({
      before: recent,
      latest: await read({ before: cursor }),
      olderPage: true,
    })
  }

  return recent
}

export function mergeThreadPages({
  before,
  latest,
  olderPage = false,
}: {
  before: ThreadPage | null
  latest: ThreadPage
  olderPage?: boolean
}): ThreadPage {
  const changedSession = before?.session !== latest.session

  if (!before || changedSession) {
    return latest
  }

  const saved = before.entries.filter(entry => olderPage || !entry.id.startsWith('live:'))
  // An older page goes first, so entries sharing a time, such as the parts of one long message, keep their order.
  const first = olderPage ? latest.entries : saved
  const then = olderPage ? saved : latest.entries
  const entries = new Map(first.map(entry => [
    entry.id,
    entry,
  ]))

  for (const entry of then) {
    entries.set(
      entry.id,
      entry,
    )
  }

  const actions = new Map((before.actions ?? []).map(event => [
    event.id,
    event,
  ]))

  for (const event of latest.actions ?? []) {
    actions.set(
      event.id,
      event,
    )
  }

  const ordered = [...entries.values()].sort((
    a,
    b,
  ) => threadEntryOrder({
    first: a,
    second: b,
  }))
  const older = olderPage ? latest.older : before.entries.length ? before.older : latest.older

  const pages = olderPage ? (before.pages ?? 1) + (latest.pages ?? 1)
    : before.pages ?? latest.pages ?? 1

  return {
    ...latest,
    entries: ordered,
    currentTurn: olderPage ? before.currentTurn : latest.currentTurn,
    actions: [...actions.values()],
    older,
    pages,
  }
}

export interface ThreadBoundary {
  session?: string
  oldest: string
}

const RESTORE_PAGE_LIMIT = 1000

export async function retainThreadPages({
  page,
  retain,
  read,
}: {
  page: ThreadPage
  retain: ThreadBoundary
  read({ before }: { before: string }): Promise<ThreadPage>
}): Promise<ThreadPage> {
  const seen = new Set<string>()
  let history = page
  const retained = () => history.entries.some(entry => entry.id === retain.oldest)
  let pages = 0

  while (history.session === retain.session && history.older && !retained()
    && pages < RESTORE_PAGE_LIMIT) {
    const cursor = history.older

    if (seen.has(cursor)) {
      throw new HydraError({
        code: 'THREAD_HISTORY_STALLED',
        message: 'Earlier conversation pages did not advance.',
      })
    }

    seen.add(cursor)
    const older = await read({ before: cursor })
    history = mergeThreadPages({
      before: history,
      latest: older,
      olderPage: true,
    })
    pages++
  }

  if (pages === RESTORE_PAGE_LIMIT && history.older && !retained()) {
    throw new HydraError({
      code: 'THREAD_HISTORY_LIMIT',
      message: 'The loaded conversation could not be fully restored.',
    })
  }

  return history
}

import { HydraError } from '#store/errors.ts'
import type { ThreadPage } from './transcripts-read.ts'
import { threadEntryOrder } from './thread-order.ts'

export const RECENT_THREAD_PAGES = 3
export const THREAD_PAGE_LIMIT = 60
export const RECENT_THREAD_ENTRIES = RECENT_THREAD_PAGES * THREAD_PAGE_LIMIT

export function threadSize({ page }: { page: ThreadPage }): number {
  return page.entries.filter(entry => !entry.id.startsWith('live:')).length
}

// A page without a count is one page.
export function pageCount({ page }: { page: ThreadPage }): number {
  return page.pages ?? 1
}

export function needsRecentThread({ page }: { page: ThreadPage }): boolean {
  const manyPages = pageCount({ page }) > RECENT_THREAD_PAGES
  const manyEntries = threadSize({ page }) > RECENT_THREAD_ENTRIES

  return page.recent !== true && (manyPages || manyEntries)
}

// The cursor of the next older page a recent window reads, or undefined once it holds RECENT_THREAD_PAGES pages.
export function nextRecentCursor({
  page,
  seen,
}: {
  page: ThreadPage
  seen: Set<string>
}): string | undefined {
  if (seen.size + 1 >= RECENT_THREAD_PAGES || !page.older) {
    return undefined
  }

  if (seen.has(page.older)) {
    throw new HydraError({
      code: 'THREAD_HISTORY_STALLED',
      message: 'Earlier conversation pages did not advance.',
    })
  }

  seen.add(page.older)

  return page.older
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

  let cursor = nextRecentCursor({
    page: recent,
    seen,
  })

  while (cursor) {
    recent = mergeThreadPages({
      before: recent,
      latest: await read({ before: cursor }),
      olderPage: true,
    })
    cursor = nextRecentCursor({
      page: recent,
      seen,
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
  // A page read again keeps how far back the loaded conversation reaches.
  const loaded = before.entries.length > 0 || (before.messages?.length ?? 0) > 0
  const older = olderPage || !loaded ? latest.older : before.older
  const pages = olderPage ? pageCount({ page: before }) + pageCount({ page: latest })
    : before.pages ?? pageCount({ page: latest })

  return {
    ...latest,
    entries: ordered,
    currentTurn: olderPage ? before.currentTurn : latest.currentTurn,
    actions: [...actions.values()],
    older,
    messages: [
      ...new Map([
        ...(before.messages ?? []),
        ...(latest.messages ?? []),
      ].map(message => [
        message.id,
        message,
      ])).values(),
    ].sort((
      a,
      b,
    ) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)),
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

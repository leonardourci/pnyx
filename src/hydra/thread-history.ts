import { HydraError } from '#store/errors.ts'
import type { ThreadPage } from './transcripts-read.ts'
import { threadEntryOrder } from './thread-order.ts'

export const THREAD_PAGE_LIMIT = 60

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

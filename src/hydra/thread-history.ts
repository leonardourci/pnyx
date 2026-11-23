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

  const retained = before.entries.filter(entry => olderPage || entry.streaming === undefined)
  const orderedPages = olderPage ? [
    latest.entries,
    retained,
  ] : [
    retained,
    latest.entries,
  ]
  const combined = orderedPages.flat()
  const savedMessages = new Set(combined.filter(entry => entry.streaming === undefined)
    .map(entry => entry.messageId ?? entry.id))
  const entries = new Map<string, ThreadPage['entries'][number]>()

  for (const entry of combined) {
    if (entry.streaming !== undefined && savedMessages.has(entry.messageId ?? entry.id)) {
      continue
    }

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

export function joinLatest({
  history,
  latest,
  read,
}: {
  history?: ThreadPage
  latest: ThreadPage
  read({ before }: { before: string }): ThreadPage
}): ThreadPage {
  const sameSession = history !== undefined && history.session === latest.session
  const held = sameSession ? history.entries.filter(entry => entry.streaming === undefined) : []

  if (!history || !held.length) {
    return mergeThreadPages({
      before: history ?? null,
      latest,
    })
  }

  const native = held.filter(entry => entry.offset !== undefined)
  const newestHasNative = latest.entries.some(entry => entry.offset !== undefined)
  const overlap = native.length || newestHasNative ? native : held
  const known = new Set(overlap.map(entry => entry.id))
  const seen = new Set<string>()
  let joined = latest

  const reachesHeld = ({ page }: { page: ThreadPage }) => page.entries
    .some(entry => known.has(entry.id))

  while (joined.older && !seen.has(joined.older) && !reachesHeld({ page: joined })) {
    seen.add(joined.older)
    joined = mergeThreadPages({
      before: joined,
      latest: read({ before: joined.older }),
      olderPage: true,
    })
  }

  return mergeThreadPages({
    before: history,
    latest: joined,
  })
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

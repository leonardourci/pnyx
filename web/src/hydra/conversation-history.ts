import { receivedThread } from '#hydra/thread-delta.ts'
import type { ThreadPage } from '#hydra/transcripts-read.ts'
import { threadEntryOrder } from '#hydra/thread-order.ts'

export async function loadEarlierMessages({
  past,
  cursor,
  until,
  message,
  load,
}: {
  past: ThreadPage | null
  cursor?: string
  until?: string
  message?: string
  load({ before }: { before: string }): Promise<ThreadPage>
}): Promise<ThreadPage | null> {
  const found = new Map((past?.entries ?? []).map(entry => [
    entry.id,
    entry,
  ]))
  const actions = new Map((past?.actions ?? []).map(event => [
    event.id,
    event,
  ]))
  let earliest = past
  const seen = new Set<string>()

  while (cursor) {
    if (seen.has(cursor)) {
      throw new Error('Earlier messages did not advance; try again.')
    }

    seen.add(cursor)
    const previous = await load({ before: cursor })
    earliest = previous

    for (const entry of previous.entries) {
      found.set(
        entry.id,
        entry,
      )
    }

    for (const event of previous.actions ?? []) {
      actions.set(
        event.id,
        event,
      )
    }

    cursor = previous.older
    const earliestAt = previous.entries[0]?.at
    const visible = previous.conversation?.entries ?? []
    const foundMessage = message && [
      ...found.values(),
      ...visible,
    ].some(entry =>
      entry.id === message || entry.messageId === message || entry.reference === message)
    const reachedTime = until === undefined || (earliestAt !== undefined && earliestAt <= until)
    const reached = message ? foundMessage : reachedTime

    if (reached) {
      break
    }
  }

  if (!earliest) {
    return null
  }

  const entries = [...found.values()].sort((
    a,
    b,
  ) => threadEntryOrder({
    first: a,
    second: b,
  }))

  return {
    ...earliest,
    entries,
    actions: [...actions.values()],
  }
}

export function receiveConversation({
  before,
  latest,
  reading,
}: {
  before: ThreadPage | null
  latest: ThreadPage
  reading: boolean
}): ThreadPage {
  const oldest = before?.entries.find(entry => !entry.id.startsWith('live:'))
  const losesRange = oldest && !latest.entries.some(entry => entry.id === oldest.id)

  if (before && reading && latest.recent && before.session === latest.session && losesRange) {
    return before
  }

  return receivedThread({
    before,
    latest,
  })
}

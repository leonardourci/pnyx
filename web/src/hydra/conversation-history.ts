import type { ThreadPage } from '#hydra/transcripts-read.ts'

export async function loadEarlierMessages({
  past,
  cursor,
  until,
  load,
}: {
  past: ThreadPage | null
  cursor?: string
  until?: string
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
    const reached = until === undefined || (earliestAt !== undefined && earliestAt <= until)

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
  ) => (a.at ?? '').localeCompare(b.at ?? ''))

  return {
    ...earliest,
    entries,
    actions: [...actions.values()],
  }
}

export { mergeThreadPages } from '#hydra/thread-history.ts'

export function receivedThread({
  before,
  latest,
}: {
  before: ThreadPage | null
  latest: ThreadPage
}): ThreadPage {
  const sameSession = before?.session === latest.session
  const sameStream = sameSession && before?.conversation?.stream === latest.conversation?.stream
  const newer = (before?.conversation?.version ?? 0) > (latest.conversation?.version ?? 0)

  return sameStream && newer ? before! : latest
}

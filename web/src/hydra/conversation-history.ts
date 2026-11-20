import type { ThreadEntry, ThreadPage } from '#hydra/transcripts-read.ts'

function holdsMessage({
  entries,
  message,
}: {
  entries: ThreadEntry[]
  message: string
}): boolean {
  return entries.some(entry =>
    entry.id === message || entry.messageId === message || entry.reference === message)
}

function reaches({
  page,
  until,
  message,
}: {
  page: ThreadPage
  until?: string
  message?: string
}): boolean {
  const earliest = page.entries[0]?.at

  if (message === undefined) {
    return until === undefined || (earliest !== undefined && earliest <= until)
  }

  const rows = [
    ...page.entries,
    ...page.conversation?.entries ?? [],
  ]
  // A comment carries its message's time, so a range older than that holds the message or never will.
  const passed = until !== undefined && earliest !== undefined && earliest < until

  return holdsMessage({
    entries: rows,
    message,
  }) || passed
}

// Reads older pages until the chat reaches a time or holds a message. Each page the server returns holds every row the
// chat loaded, and reaches the chat through the connection's thread store.
export async function loadEarlierMessages({
  page,
  until,
  message,
  load,
}: {
  page?: ThreadPage | null
  until?: string
  message?: string
  load({ before }: { before: string }): Promise<ThreadPage>
}) {
  const seen = new Set<string>()
  let current = page

  while (current?.older && !reaches({
    page: current,
    until,
    message,
  })) {
    const cursor = current.older

    if (seen.has(cursor)) {
      throw new Error('Earlier messages did not advance; try again.')
    }

    seen.add(cursor)
    current = await load({ before: cursor })
  }
}

// The thread arguments that open a chat, restoring the range it had loaded by its session and oldest entry.
export function threadArgs({
  card,
  page,
}: {
  card: string
  page?: ThreadPage | null
}): string[] {
  const oldest = page?.entries[0]

  if (!page || !oldest) {
    return [card]
  }

  return [
    card,
    '--retain',
    JSON.stringify({
      session: page.session,
      oldest: oldest.id,
    }),
  ]
}

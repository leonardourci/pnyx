import type { ThreadPage } from './transcripts-read.ts'

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
  const entries = new Map(saved.map(entry => [
    entry.id,
    entry,
  ]))

  for (const entry of latest.entries) {
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
  ) => (a.at ?? '').localeCompare(b.at ?? ''))
  const older = olderPage ? latest.older : before.entries.length ? before.older : latest.older

  return {
    ...latest,
    entries: ordered,
    currentTurn: olderPage ? before.currentTurn : latest.currentTurn,
    actions: [...actions.values()],
    older,
  }
}

import { AUTO_TITLE_SOURCES, type Card, type AutoTitle } from './model.ts'
import type { SourceRef, HydraState } from '#app/model.ts'
import { LEGACY_IN_PROGRESS, type Column } from './columns-model.ts'
import { hydraConfig } from '#hydra/config.ts'
import { roleColumn, fallbackColumn } from './column-rules.ts'

// Keeps the best auto title seen: a better source replaces a worse one, a later
// session title or folder replaces an earlier one, and the first prompt stays. It
// becomes the title only while no push has set one.
export function offerTitle({
  card,
  next,
}: {
  card: Card
  next: AutoTitle
}): void {
  const current = card.autoTitle

  if (current) {
    const rank = AUTO_TITLE_SOURCES.indexOf(next.from) - AUTO_TITLE_SOURCES.indexOf(current.from)

    if (rank > 0 || (rank === 0 && next.from === 'prompt')) {
      return
    }
  }

  card.autoTitle = next

  if (!card.titleSet) {
    card.title = next.text
  }
}

export function sameSource({
  a,
  b,
}: {
  a: SourceRef
  b: SourceRef
}): boolean {
  return a.adapter === b.adapter && a.instanceId === b.instanceId && a.objectId === b.objectId
}

export function isStaleSource({
  card,
  source,
}: {
  card: Card | undefined
  source: SourceRef
}): boolean {
  const known = card?.sourceRefs.find(r => sameSource({
    a: r,
    b: source,
  }))

  if (!known) {
    return false
  }

  const knownGen = known.generation ?? 0
  const gen = source.generation ?? 0

  if (gen !== knownGen) {
    return gen < knownGen
  }

  // ISO-8601 UTC timestamps compare correctly as strings.
  return known.observedAt !== undefined
    && source.observedAt !== undefined
    && source.observedAt < known.observedAt
}

export function wouldCycle({
  cards,
  cardId,
  parentId,
}: {
  cards: Record<string, Card>
  cardId: string
  parentId: string
}): boolean {
  const seen = new Set<string>()

  for (let p: string | undefined = parentId; p !== undefined; p = cards[p]?.parentId) {
    if (p === cardId || seen.has(p)) {
      return true
    }

    seen.add(p)
  }

  return false
}

export function newCardColumn({ state }: { state: HydraState }): Column {
  const columns = hydraConfig({ state }).columns

  return columns.some(c => c.id === LEGACY_IN_PROGRESS) ? LEGACY_IN_PROGRESS : roleColumn({
    columns,
    role: 'in_progress',
  }) ?? fallbackColumn({ columns })
}

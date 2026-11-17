import { CARD_SIZING } from '#web-shared/card-sizing.ts'
import type { Card } from '#tasks/model.ts'

export const PROJECT_CONTENT_INSET = 18
export const SUBTASK_INDENT = 26

export function expandedTaskWidth({
  card,
}: {
  card: Card
}) {
  return CARD_SIZING.open.minWidth + (card.parentId ? SUBTASK_INDENT : 0)
}

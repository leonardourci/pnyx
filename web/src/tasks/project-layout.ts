import { OPEN_CARD_MIN_WIDTH } from '#preferences/workspace.ts'
import type { Card } from '#tasks/model.ts'

export const CLOSED_CARD_MIN_WIDTH = 258
export const PROJECT_CONTENT_INSET = 18
export const SUBTASK_INDENT = 26

export function expandedTaskWidth({
  card,
}: {
  card: Card
}) {
  return OPEN_CARD_MIN_WIDTH + (card.parentId ? SUBTASK_INDENT : 0)
}

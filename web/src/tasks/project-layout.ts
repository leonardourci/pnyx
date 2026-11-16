import { DEFAULT_OPEN_CARD_WIDTH } from '#preferences/workspace.ts'
import type { Card } from '#tasks/model.ts'

export const CLOSED_CARD_MIN_WIDTH = 258
export const CARD_GAP = 8
export const PROJECT_CONTENT_INSET = 18
export const SUBTASK_INDENT = 26

export function expandedTaskWidth({
  card,
  widths,
}: {
  card: Card
  widths: Record<string, number>
}) {
  const width = widths[card.id] ?? DEFAULT_OPEN_CARD_WIDTH

  return width + (card.parentId ? SUBTASK_INDENT : 0)
}

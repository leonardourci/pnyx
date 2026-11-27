import { DEFAULT_PROJECT_WIDTH, PROJECT_MIN_WIDTH } from '#preferences/workspace.ts'
import { CARD_SIZING, WORKSPACE_SIZING, phoneLayout } from '#web-shared/card-sizing.ts'
import type { Card } from '#tasks/model.ts'

export const PROJECT_CONTENT_INSET = 18
const SUBTASK_INDENT = WORKSPACE_SIZING.subtaskIndent

export function expandedTaskWidth({
  card,
}: {
  card: Card
}) {
  return CARD_SIZING.open.minWidth + (card.parentId ? SUBTASK_INDENT : 0)
}

export function projectWidth({
  id,
  widths,
  expandedWidth = 0,
  viewport,
  preview,
}: {
  id: string
  widths: Record<string, number>
  expandedWidth?: number
  viewport: number
  preview?: number | null
}) {
  const phone = phoneLayout({ width: viewport })
  const minimum = Math.max(
    PROJECT_MIN_WIDTH,
    expandedWidth + PROJECT_CONTENT_INSET,
  )
  const saved = widths[id] ?? (id === 'ideas' ? PROJECT_MIN_WIDTH : DEFAULT_PROJECT_WIDTH)

  return {
    phone,
    minimum: phone ? viewport - WORKSPACE_SIZING.phoneFrameMargin : minimum,
    width: phone ? viewport - WORKSPACE_SIZING.phoneFrameMargin : Math.max(
      preview ?? saved,
      minimum,
    ),
  }
}

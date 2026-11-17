import { DEFAULT_OPEN_CARD_HEIGHT, OPEN_CARD_MIN_HEIGHT, OPEN_CARD_MIN_WIDTH } from '#preferences/workspace.ts'

export const CARD_SIZING = {
  closed: {
    minWidth: 258,
    minHeight: 96,
  },
  nest: {
    hoverScale: 0.84,
    dropScale: 0.12,
  },
  open: {
    minWidth: OPEN_CARD_MIN_WIDTH,
    minHeight: OPEN_CARD_MIN_HEIGHT,
    height: DEFAULT_OPEN_CARD_HEIGHT,
  },
  modal: {
    margin: 16,
    widthFraction: 0.65,
  },
} as const

export function liftedCardSize({
  size,
  columnWidth,
  gap,
  indent = 0,
  open = false,
}: {
  size: {
    width: number
    height: number
  }
  columnWidth: number
  gap: number
  indent?: number
  open?: boolean
}) {
  const count = Math.max(
    1,
    Math.floor((columnWidth + gap) / (CARD_SIZING.closed.minWidth + gap)),
  )
  const cell = (columnWidth - gap * (count - 1)) / count - indent

  if (!open && size.width <= Math.ceil(cell)) {
    return size
  }

  return {
    width: Math.min(
      size.width,
      cell,
    ),
    height: open ? CARD_SIZING.closed.minHeight : size.height,
  }
}

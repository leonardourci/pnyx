import { DEFAULT_OPEN_CARD_HEIGHT, OPEN_CARD_MIN_HEIGHT, OPEN_CARD_MIN_WIDTH } from '#preferences/workspace.ts'

const styles = typeof document === 'undefined' ? undefined : getComputedStyle(document.documentElement)
const spacing = styles?.getPropertyValue('--spacing').trim() ?? ''
const rootFont = parseFloat(styles?.fontSize ?? '16')
const parsedSpacing = parseFloat(spacing) * (spacing.endsWith('rem') ? rootFont : 1)
const unit = Number.isFinite(parsedSpacing) ? parsedSpacing : 4

const closedMinimumWidth = parseFloat(styles?.getPropertyValue('--spacing-card-min') ?? '')
const closedMinimumHeight = parseFloat(
  styles?.getPropertyValue('--spacing-card-closed-height') ?? '',
)
const subtaskIndent = parseFloat(styles?.getPropertyValue('--spacing-subtask-indent') ?? '')

export const WORKSPACE_SIZING = {
  subtaskIndent: Number.isFinite(subtaskIndent) ? subtaskIndent : 26,
  cardGap: unit * 2,
  columnGap: unit * 2.5,
  inset: unit * 4 + 2,
  phoneInset: unit * 3 + 2,
  foldedColumn: unit * 12,
  createColumn: unit * 57.5,
  foldedChat: unit * 10,
  phone: unit * 190,
  phoneChatInset: unit * 9.5,
  frameMargin: unit * 6,
  phoneFrameMargin: unit * 3,
} as const

export const CARD_SIZING = {
  closed: {
    minWidth: Number.isFinite(closedMinimumWidth) ? closedMinimumWidth : 260,
    minHeight: Number.isFinite(closedMinimumHeight) ? closedMinimumHeight : 96,
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
    widthFraction: 0.7,
    heightFraction: 0.8,
  },
} as const

function cardGrid({
  width,
  gap = WORKSPACE_SIZING.cardGap,
}: {
  width: number
  gap?: number
}) {
  const columns = Math.max(
    1,
    Math.floor((width + gap) / (CARD_SIZING.closed.minWidth + gap)),
  )

  return {
    columns,
    cell: (width - gap * (columns - 1)) / columns,
  }
}

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
  const grid = cardGrid({
    width: columnWidth,
    gap,
  })
  const cell = grid.cell - indent

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

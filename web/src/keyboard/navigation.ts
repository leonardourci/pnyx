export interface ColumnCards { id: string; cards: string[] }
export interface BoardAnchor { column: string; card?: string }

export function navigate(
  columns: ColumnCards[],
  current: BoardAnchor,
  action: string,
  remembered: Record<string, string>,
): BoardAnchor {
  const column = Math.max(0, columns.findIndex(c => c.id === current.column))
  const list = columns[column]

  if (!list) {
    return current
  }

  const row = Math.max(0, list.cards.indexOf(current.card ?? ''))

  if (action === 'board.left' || action === 'board.right') {
    const next = columns[Math.max(0, Math.min(columns.length - 1, column + (action === 'board.left' ? -1 : 1)))]

    return {
      column: next.id,
      card: next.cards.includes(remembered[next.id])
        ? remembered[next.id]
        : next.cards[Math.min(row, next.cards.length - 1)],
    }
  }

  const index = action === 'board.first' ? 0 : action === 'board.last' ? list.cards.length - 1 : Math.max(0, Math.min(list.cards.length - 1, row + (action === 'board.up' ? -1 : 1)))

  return { column: list.id, card: list.cards[index] }
}

export function restoreAnchor(
  columns: ColumnCards[],
  previous: ColumnCards[],
  anchor: BoardAnchor,
): BoardAnchor {
  const same = columns.find(c => c.cards.includes(anchor.card ?? ''))

  if (same) {
    return { column: same.id, card: anchor.card }
  }

  const column = columns.find(c => c.id === anchor.column)
    ?? columns[Math.max(
      0,
      Math.min(columns.length - 1, previous.findIndex(c => c.id === anchor.column)),
    )]

  if (!column) {
    return anchor
  }

  const row = Math.max(0, previous.find(c => c.id === anchor.column)?.cards.indexOf(anchor.card ?? '') ?? 0)

  return { column: column.id, card: column.cards[Math.min(row, column.cards.length - 1)] }
}

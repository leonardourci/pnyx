export type PaletteKey = 'wait' | 'up' | 'down' | 'open' | 'open-elsewhere' | 'commit' | 'drop-filter' | 'clear' | 'close'

export const WAITING_KEYS = [
  'Enter',
  'ArrowDown',
  'ArrowUp',
]

// The bar's keys: the filter menu takes them while a filter is half-typed, and Enter and the arrows wait for a pending answer.
export function paletteKey({
  key,
  shift = false,
  mod = false,
  composing,
  pending,
  token,
  query,
  onAction = false,
}: {
  key: string
  shift?: boolean
  mod?: boolean
  composing: boolean
  pending: boolean
  token?: string
  query: string
  // The menu's selection is an action rather than a filter.
  onAction?: boolean
}): PaletteKey | null {
  if (composing) {
    return null
  }

  if (token !== undefined) {
    return menuKey({
      key,
      shift,
      mod,
      token,
      onAction,
    })
  }

  if (key === 'Escape') {
    return query ? 'clear' : 'close'
  }

  if (pending && WAITING_KEYS.includes(key)) {
    return 'wait'
  }

  if (key === 'ArrowDown') {
    return 'down'
  }

  if (key === 'ArrowUp') {
    return 'up'
  }

  if (key !== 'Enter') {
    return null
  }

  return mod ? 'open-elsewhere' : 'open'
}

// Space and Tab make the selected filter a badge; on an action, Enter runs it, Space does nothing and Tab is the focus cycle's.
function menuKey({
  key,
  shift,
  mod,
  token,
  onAction,
}: {
  key: string
  shift: boolean
  mod: boolean
  token: string
  onAction: boolean
}): PaletteKey | null {
  if (key === 'Escape') {
    return 'drop-filter'
  }

  if (key === 'ArrowDown') {
    return 'down'
  }

  if (key === 'ArrowUp') {
    return 'up'
  }

  if (key === 'Enter' && onAction) {
    return mod ? 'open-elsewhere' : 'open'
  }

  if (key === 'Tab' && onAction) {
    return null
  }

  // A space right after a bare > is just typed.
  const typedSpace = key === ' ' && token === '>'
  const commits = key === 'Enter' || key === ' ' || (key === 'Tab' && !shift)

  return commits && !typedSpace ? 'commit' : null
}

export interface Chosen {
  // The query the choice was made for; a new query starts at its own top result.
  key: string
  id: string
}

export const selectedId = ({
  ids,
  chosen,
  key,
}: {
  ids: string[]
  chosen?: Chosen
  key: string
}) => chosen?.key === key && ids.includes(chosen.id) ? chosen.id : ids[0]

export function movedId({
  ids,
  current,
  step,
}: {
  ids: string[]
  current?: string
  step: number
}): string | undefined {
  const at = current === undefined ? -1 : ids.indexOf(current)

  return ids[Math.max(
    0,
    Math.min(
      ids.length - 1,
      at + step,
    ),
  )]
}

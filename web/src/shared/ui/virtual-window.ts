export interface VirtualWindow {
  // The rows from start up to end exist on the page; the spacers stand in for the rest.
  start: number
  end: number
  before: number
  after: number
}

// Which rows of a list to render: those within `overscan` pixels of the viewport, given each row's measured height or
// an estimate until it has one. A list of `minimum` rows or fewer renders whole.
export function virtualWindow({
  keys,
  sizes,
  estimate,
  top,
  bottom,
  overscan,
  minimum,
}: {
  keys: readonly string[]
  sizes: ReadonlyMap<string, number>
  estimate: number
  // The part of the list above the viewport's top edge, and the viewport's bottom edge, in pixels from the list's top.
  top: number
  bottom: number
  overscan: number
  minimum: number
}): VirtualWindow {
  if (keys.length <= minimum) {
    return {
      start: 0,
      end: keys.length,
      before: 0,
      after: 0,
    }
  }

  let offset = 0
  let start = keys.length
  let end = keys.length
  let before = 0
  let used = 0

  for (let index = 0; index < keys.length; index++) {
    const size = sizes.get(keys[index]!) ?? estimate

    if (start === keys.length && offset + size >= top - overscan) {
      start = index
      before = offset
    }

    if (start !== keys.length && end === keys.length && offset >= bottom + overscan) {
      end = index
      used = offset
    }

    offset += size
  }

  if (start === keys.length) {
    // Scrolled past every row: keep the last ones.
    start = Math.max(
      0,
      keys.length - 1,
    )
    before = offset - (sizes.get(keys[start]!) ?? estimate)
  }

  return {
    start,
    end,
    before,
    after: end === keys.length ? 0 : offset - used,
  }
}

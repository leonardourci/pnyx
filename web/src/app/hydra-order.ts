import type { HydraSummary } from '#app/server-hydras.ts'

// Order keys sit between their neighbors', so a move usually writes one event to the moved Hydra only.
const ORDER_GAP = 1000

// The positions a move writes: the moved Hydra's alone, or, when its neighbors leave no room between
// them (equal keys, or a gap halved too often), every Hydra renumbered in the new order.
export const placements = ({
  hydras,
  id,
  index,
}: {
  hydras: HydraSummary[]
  id: string
  index: number
}) => {
  const others = hydras.filter(h => h.id !== id)
  const before = others[index - 1], after = others[index]
  let position: number

  if (before && after) {
    position = (before.order + after.order) / 2
  } else if (before) {
    position = before.order + ORDER_GAP
  } else {
    // A move always has another Hydra beside it, so with no Hydra before there is one after.
    position = after!.order - ORDER_GAP
  }

  const fits = (!before || position > before.order) && (!after || position < after.order)

  if (fits) {
    return [
      {
        id,
        position,
      },
    ]
  }

  // The moved Hydra comes from this list.
  const moved = hydras.find(h => h.id === id)!
  const ordered = [
    ...others.slice(
      0,
      index,
    ),
    moved,
    ...others.slice(index),
  ]
  const base = Math.min(...hydras.map(h => h.order))

  return ordered.map((
    hydra,
    n,
  ) => ({
    id: hydra.id,
    position: base + n * ORDER_GAP,
  })).filter(placement => placement.position !== hydras.find(h => h.id === placement.id)?.order)
}

// Motion transforms must not change a virtual list's scroll anchor.
export function layoutOffset({
  element,
  horizontal,
}: {
  element: HTMLElement
  horizontal: boolean
}) {
  let offset = 0
  let parent: HTMLElement | null = element

  while (parent) {
    offset += horizontal ? parent.offsetLeft + (parent.offsetParent?.clientLeft ?? 0)
      : parent.offsetTop + (parent.offsetParent?.clientTop ?? 0)
    const offsetParent = parent.offsetParent
    parent = offsetParent instanceof HTMLElement ? offsetParent : null
  }

  return offset
}

// A drop lands at the layout position while Motion finishes moving the visible card.
export function layoutBox({ element }: { element: HTMLElement }) {
  let left = layoutOffset({
    element,
    horizontal: true,
  })
  let top = layoutOffset({
    element,
    horizontal: false,
  })

  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    left -= parent.scrollLeft
    top -= parent.scrollTop
  }

  return {
    left,
    top,
    width: element.offsetWidth,
    height: element.offsetHeight,
  }
}

// Offset properties give scroll anchors a stable layout position during transforms.
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
    const offsetParent: Element | null = parent.offsetParent
    const position = horizontal ? parent.offsetLeft : parent.offsetTop
    const border = horizontal ? offsetParent?.clientLeft : offsetParent?.clientTop
    offset += position + (border ?? 0)
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

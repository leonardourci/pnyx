// A drop lands at the layout position while Motion finishes moving the visible card.
export function layoutBox({ element }: { element: HTMLElement }) {
  let left = 0
  let top = 0

  for (let box: HTMLElement | null = element; box; box = box.offsetParent as HTMLElement | null) {
    left += box.offsetLeft + (box.offsetParent?.clientLeft ?? 0)
    top += box.offsetTop + (box.offsetParent?.clientTop ?? 0)
  }

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

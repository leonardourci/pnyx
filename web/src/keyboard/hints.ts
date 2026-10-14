export interface Hint { label: string; element: HTMLElement; x: number; y: number }

export function hintLabels(count: number): string[] {
  const alphabet = 'asdfghjkl', width = Math.max(1, Math.ceil(Math.log(Math.max(1, count)) / Math.log(alphabet.length)))

  return Array.from({ length: count }, (_, i) => {
    let label = ''

    for (let n = 0; n < width; n++) {
      label = alphabet[i % alphabet.length] + label; i = Math.floor(i / alphabet.length)
    }

    return label
  })
}

export function visibleTargets(): Omit<Hint, 'label'>[] {
  return [...document.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),[role=separator],[data-key-scope=thread],[data-empty-column]')].flatMap(element => {
    if (element.closest('[inert],[aria-hidden=true]') || !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
      return []
    }

    const rect = element.getBoundingClientRect()
    let left = Math.max(0, rect.left), right = Math.min(innerWidth, rect.right), top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom)

    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent), box = parent.getBoundingClientRect()

      if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
        left = Math.max(left, box.left); right = Math.min(right, box.right)
      }

      if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
        top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom)
      }
    }

    if (right - left < 2 || bottom - top < 2) {
      return []
    }

    const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2)

    if (hit && !element.contains(hit)) {
      return []
    }

    return [{ element, x: left, y: top }]
  })
}

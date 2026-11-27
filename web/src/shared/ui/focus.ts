export const isEditing = ({ target }: { target: Element }) =>
  !!target.closest('input,textarea,[contenteditable]')

export function focusElement({ selector }: { selector: string }) {
  const element = document.querySelector<HTMLElement>(selector)

  if (!element) {
    return false
  }

  const inColumns = element.closest('.kanban') !== null
  let behavior: ScrollBehavior | undefined

  if (inColumns) {
    behavior = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'
  }

  element.focus({ preventScroll: true })
  element.scrollIntoView({
    block: 'nearest',
    inline: 'nearest',
    behavior,
  })

  return document.activeElement === element
}

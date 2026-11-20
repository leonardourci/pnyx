import { CARET_HOST } from '#web-hydra/caret.ts'

export const isEditing = ({ target }: { target: Element }) => {
  const field = target.closest('input,textarea,[contenteditable]:not([contenteditable=false])')

  const isMessageCaret = field?.hasAttribute(CARET_HOST)

  return !!field && !isMessageCaret
}

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

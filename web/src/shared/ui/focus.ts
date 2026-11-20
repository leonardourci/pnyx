import { CARET_HOST } from '#web-hydra/caret.ts'

export const isEditing = ({ target }: { target: Element }) => {
  const field = target.closest('input,textarea,[contenteditable]:not([contenteditable=false])')

  const isMessageCaret = field?.hasAttribute(CARET_HOST)

  return !!field && !isMessageCaret
}

export function focusElement({ selector }: { selector: string }) {
  const element = document.querySelector<HTMLElement>(selector)
  element?.focus({ preventScroll: true }); element?.scrollIntoView({
    block: 'nearest',
    inline: 'nearest',
    ...(element.closest('.kanban')
      ? { behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' } as const
      : {}),
  })

  return !!element && document.activeElement === element
}

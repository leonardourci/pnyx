import { CARET_HOST } from '#web-hydra/caret.ts'

// The caret host is editable only to draw a caret, so its keys are not typing.
export const isEditing = ({ target }: { target: Element }) => {
  const field = target.closest('input,textarea,[contenteditable]:not([contenteditable=false])')

  return !!field && !field.hasAttribute(CARET_HOST)
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

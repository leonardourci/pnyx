import { useId, useMemo, type ReactNode } from 'react'
import { Button } from './controls.tsx'
import { CollapsibleText } from './disclosure.tsx'
import { markdownText } from '#web-titan/markdown-text.ts'
import { RichText } from './rich-text.tsx'

export function ChoiceOption({
  label,
  description,
  selected,
  choose,
  children,
}: {
  label: string
  description?: string
  selected: boolean
  choose(): void
  children?: ReactNode
}) {
  const id = useId()
  const name = useMemo(
    () => markdownText({ text: label }),
    [label],
  )

  return (
    <div className="ask-option relative flex min-w-0 flex-col items-start justify-start gap-0.5 rounded-lg border border-line bg-surface px-1.75 py-1.25 text-left has-[.ask-option-pick:focus-visible]:outline-2 has-[.ask-option-pick:focus-visible]:outline-offset-2 has-[.ask-option-pick:focus-visible]:outline-gold has-[.ask-option-pick:hover]:bg-hover data-selected:border-gold data-selected:text-gold [&_:is(a,button,[role=button]):not(.ask-option-pick)]:pointer-events-auto [&>:not(.ask-option-pick)]:pointer-events-none [&>:not(.ask-option-pick)]:relative" data-selected={selected || undefined}>
      <Button
        contentEditable={false}
        className="ask-option-pick absolute inset-0 h-full min-h-0 w-full rounded-inherit border-0 bg-transparent p-0 focus-visible:outline-none enabled:hover:bg-transparent"
        aria-label={`Choose ${name}`}
        aria-pressed={selected}
        aria-describedby={`${id}-details`}
        onClick={choose}
      />
      <div className="ask-option-heading flex w-full min-w-0 items-baseline gap-1 [&>.ask-label]:flex-1">
        <CollapsibleText className="ask-label text-chat leading-(--chat-line)" text={label} />
        {children}
      </div>
      <div id={`${id}-details`} className="ask-option-details w-full min-w-0 empty:hidden">
        {children && <span className="sr-only">Recommended. </span>}
        {description && description !== label && <div className="ask-description w-full min-w-0 text-chat text-muted [&_.markdown]:line-clamp-1 [&_.markdown]:max-h-line [&_.markdown_p]:inline"><RichText text={description} /></div>}
      </div>
    </div>
  )
}

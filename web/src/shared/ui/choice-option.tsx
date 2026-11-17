import { useId, useMemo, type ReactNode } from 'react'
import { Button } from './controls.tsx'
import { CollapsibleText } from './disclosure.tsx'
import { markdownText } from '#web-hydra/markdown-text.ts'
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
    <div className="ask-option relative flex min-w-0 justify-start flex-col items-start gap-0.5 py-1.25 px-1.75 border border-line rounded-lg bg-surface text-left data-selected:border-gold data-selected:text-gold [&>:not(.ask-option-pick)]:relative [&>:not(.ask-option-pick)]:pointer-events-none [&_:is(a,button,[role=button]):not(.ask-option-pick)]:pointer-events-auto has-[.ask-option-pick:focus-visible]:outline-2 has-[.ask-option-pick:focus-visible]:outline-gold has-[.ask-option-pick:focus-visible]:outline-offset-2 has-[.ask-option-pick:hover]:bg-hover" data-selected={selected || undefined}>
      <Button
        contentEditable={false}
        className="ask-option-pick absolute inset-0 w-full h-full min-h-0 p-0 border-0 rounded-[inherit] bg-transparent enabled:hover:bg-transparent focus-visible:outline-none"
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
        {description && description !== label && <div className="ask-description w-full min-w-0 text-chat text-muted [&_.markdown]:line-clamp-1 [&_.markdown]:max-h-[1lh] [&_.markdown_p]:inline"><RichText text={description} /></div>}
      </div>
    </div>
  )
}

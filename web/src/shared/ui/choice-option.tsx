import { useId, useMemo, type ReactNode } from 'react'
import { Button } from './controls.tsx'
import { CollapsibleText } from './disclosure.tsx'
import { Markdown, markdownText } from '../../components/ui/markdown.tsx'

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
    <div className="ask-option" data-selected={selected || undefined}>
      <Button
        contentEditable={false}
        className="ask-option-pick"
        aria-label={`Choose ${name}`}
        aria-pressed={selected}
        aria-describedby={`${id}-details`}
        onClick={choose}
      />
      <div className="ask-option-heading">
        <CollapsibleText className="ask-label" text={label} />
        {children}
      </div>
      <div id={`${id}-details`} className="ask-option-details">
        {children && <span className="sr-only">Recommended. </span>}
        {description && description !== label && <div className="ask-description"><Markdown text={description} /></div>}
      </div>
    </div>
  )
}

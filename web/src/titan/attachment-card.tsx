import type { MouseEvent, ReactNode } from 'react'
import { Button } from '#web-shared/ui/controls.tsx'
import { ICON_SIZE, Icon } from '#web-shared/icons.tsx'

export function AttachmentCard({
  slot,
  label,
  title,
  tone,
  open,
  remove,
  removeLabel,
  removeText,
  leaveRemove,
  keepsInputFocus = false,
}: {
  slot: ReactNode
  label: ReactNode
  title?: string
  tone?: 'comments' | 'reference'
  open?(): void
  remove?(): void
  removeLabel?: string
  removeText?: ReactNode
  leaveRemove?(): void
  keepsInputFocus?: boolean
}) {
  const tabIndex = keepsInputFocus ? -1 : undefined

  const keepFocus = ({ event }: { event: MouseEvent }) => {
    if (keepsInputFocus) {
      event.preventDefault()
    }
  }

  const button = 'min-h-0 rounded-none border-0 p-0 [font:inherit] text-inherit hover:enabled:bg-raised group-data-[tone=comments]/attachment:hover:enabled:bg-attachment-comments'
  const mainClass = 'card-main inline-flex min-w-0 flex-1 items-center justify-start gap-(--spacing-attachment-gap) pl-(--spacing-attachment-inset) pr-(--spacing-attachment-end)'
  const toneClass = tone === 'comments' ? 'border-gold-line bg-gold-wash text-gold' : 'border-line bg-surface text-ink'

  const main = (
    <>
      <span className="card-slot relative grid h-(--spacing-attachment-icon) w-(--spacing-attachment-slot) shrink-0 place-items-center overflow-hidden rounded-(--spacing-attachment-inset) bg-raised group-data-[tone=comments]/attachment:bg-attachment-comments [&>img]:absolute [&>img]:inset-0 [&>img]:size-full [&>img]:object-contain [&>img[data-loading]]:hidden">{slot}</span>
      <span className="card-label min-w-0 overflow-hidden text-ellipsis text-attachment">{label}</span>
    </>
  )

  return (
    <span className={`attachment-card group/attachment relative -top-(--spacing-attachment-top) inline-flex h-(--chip-h) max-w-full select-none items-stretch overflow-hidden rounded-(--spacing-attachment-gap) border font-sans leading-none whitespace-nowrap align-middle data-[tone=reference]:border-dashed data-[tone=reference]:bg-transparent ${toneClass} ${tone ?? ''}`} data-tone={tone}>
      {open ? (
        <Button
          className={`${button} ${mainClass}`}
          title={title}
          tabIndex={tabIndex}
          onMouseDown={event => keepFocus({ event })}
          onClick={open}
        >
          {main}
        </Button>
      ) : <span className={mainClass} title={title}>{main}</span>}
      {remove && (
        <Button
          className={`card-x w-(--chip-h) shrink-0 border-l! border-line text-muted group-data-[tone=comments]/attachment:border-gold-line group-data-[tone=comments]/attachment:text-gold ${button}`}
          aria-label={removeLabel}
          tabIndex={tabIndex}
          onMouseDown={event => keepFocus({ event })}
          onBlur={leaveRemove}
          onClick={remove}
        >
          {removeText ?? <Icon name="close" size={ICON_SIZE.inline} />}
        </Button>
      )}
    </span>
  )
}

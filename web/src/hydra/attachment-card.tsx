import type { MouseEvent, ReactNode } from 'react'
import { Button } from '../shared/ui/controls.tsx'
import { Icon } from '../shared/ui/icon.tsx'

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
  // Drawn over the composer's textarea, the card answers the mouse but leaves focus and Tab to the textarea.
  keepsInputFocus?: boolean
}) {
  const tabIndex = keepsInputFocus ? -1 : undefined

  const keepFocus = ({ event }: { event: MouseEvent }) => {
    if (keepsInputFocus) {
      event.preventDefault()
    }
  }

  const main = (
    <>
      <span className="card-slot">{slot}</span>
      <span className="card-label">{label}</span>
    </>
  )

  return (
    <span className={`attachment-card ${tone ?? ''}`} contentEditable={false}>
      {open ? (
        <Button
          className="card-main"
          title={title}
          tabIndex={tabIndex}
          onMouseDown={event => keepFocus({ event })}
          onClick={open}
        >
          {main}
        </Button>
      ) : <span className="card-main" title={title}>{main}</span>}
      {remove && (
        <Button
          className="card-x"
          aria-label={removeLabel}
          tabIndex={tabIndex}
          onMouseDown={event => keepFocus({ event })}
          onBlur={leaveRemove}
          onClick={remove}
        >
          {removeText ?? <Icon name="close" size={14} />}
        </Button>
      )}
    </span>
  )
}

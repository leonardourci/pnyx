import { useEffect, useRef, type HTMLAttributes } from 'react'

export function EditableTitle({
  value,
  label,
  editingLabel,
  activate,
  editing,
  edit,
  finished,
  save,
  notify,
  disabled = false,
  className = '',
  ...props
}: {
  value: string
  label: string
  editingLabel: string
  activate({ pointer }: { pointer: boolean }): void
  editing: boolean
  edit(): void
  finished(): void
  save({ title }: { title: string }): Promise<unknown>
  notify({ text }: { text: string }): void
  disabled?: boolean
} & HTMLAttributes<HTMLDivElement>) {
  const element = useRef<HTMLDivElement>(null)
  const active = useRef(false)
  const initial = useRef(value)
  useEffect(
    () => {
      if (!editing && element.current) {
        element.current.textContent = value
      }
    },
    [
      editing,
      value,
    ],
  )

  useEffect(
    () => {
      if (!editing) {
        return
      }

      active.current = true
      const frame = requestAnimationFrame(() => {
        const title = element.current

        if (!title || !active.current) {
          return
        }

        title.focus({ preventScroll: true })
        const range = document.createRange()
        range.selectNodeContents(title)
        range.collapse(false)
        const selection = window.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
      })

      return () => cancelAnimationFrame(frame)
    },
    [editing],
  )

  const finish = async ({ cancel = false }: { cancel?: boolean }) => {
    if (!active.current) {
      return
    }

    active.current = false
    const title = element.current?.textContent?.replace(
      /\s+/g,
      ' ',
    ).trim() ?? ''
    finished()

    if (element.current) {
      element.current.textContent = value
    }

    if (cancel || !title || title === value) {
      return
    }

    try {
      await save({ title })
    } catch (error) {
      notify({ text: error instanceof Error ? error.message : String(error) })
    }
  }

  return (
    <div
      {...props}
      ref={element}
      className={`button ${className}`}
      role={editing ? 'textbox' : 'button'}
      aria-label={editing ? editingLabel : label}
      aria-expanded={editing ? undefined : props['aria-expanded']}
      aria-description="Press F2 to edit the title"
      contentEditable={editing ? 'plaintext-only' : false}
      suppressContentEditableWarning
      onClick={event => {
        event.stopPropagation()

        if (!editing) {
          activate({ pointer: event.detail > 0 })
        }
      }}
      onDoubleClick={event => {
        event.preventDefault()
        event.stopPropagation()
      }}
      onBlur={() => void finish({})}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing) {
          return
        }

        if (editing && (event.key === 'Enter' || event.key === 'Escape')) {
          event.preventDefault()
          event.stopPropagation()
          void finish({ cancel: event.key === 'Escape' })
        } else if (!editing && !disabled && event.key === 'F2') {
          event.preventDefault()
          event.stopPropagation()
          edit()
        } else if (!editing && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault()
          event.stopPropagation()
          activate({ pointer: false })
        }
      }}
    >{initial.current}
    </div>
  )
}

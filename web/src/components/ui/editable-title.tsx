import { useEffect, useRef, useState, type HTMLAttributes } from 'react'

export const DOUBLE_CLICK_MS = 500

export function EditableTitle({
  value,
  label,
  editingLabel,
  activate,
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
  save({ title }: { title: string }): Promise<unknown>
  notify({ text }: { text: string }): void
  disabled?: boolean
} & HTMLAttributes<HTMLDivElement>) {
  const element = useRef<HTMLDivElement>(null)
  const click = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const active = useRef(false)
  const initial = useRef(value)
  const [
    editing,
    setEditing,
  ] = useState(false)
  const clearClick = () => clearTimeout(click.current)
  useEffect(
    () => clearClick,
    [],
  )
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

  const begin = () => {
    clearClick()

    if (disabled) {
      return
    }

    active.current = true
    setEditing(true)
    requestAnimationFrame(() => {
      const title = element.current

      if (!title || !active.current) {
        return
      }

      title.focus()
      const range = document.createRange()
      range.selectNodeContents(title)
      range.collapse(false)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
    })
  }

  const finish = async ({ cancel = false }: { cancel?: boolean }) => {
    if (!active.current) {
      return
    }

    active.current = false
    const title = element.current?.textContent?.replace(
      /\s+/g,
      ' ',
    ).trim() ?? ''
    setEditing(false)

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
      aria-description="Double-click or press F2 to edit the title"
      contentEditable={editing ? 'plaintext-only' : false}
      suppressContentEditableWarning
      onClick={event => {
        event.stopPropagation()

        if (!editing) {
          clearClick()

          if (event.detail === 0) {
            activate({ pointer: false })
          } else if (event.detail === 1 && props['aria-expanded'] !== true) {
            activate({ pointer: true })
          } else if (event.detail === 1) {
            // Only closing waits, so a double-click on an open card edits without closing it.
            click.current = setTimeout(
              () => activate({ pointer: true }),
              DOUBLE_CLICK_MS,
            )
          }
        }
      }}
      onDoubleClick={event => {
        event.preventDefault()
        event.stopPropagation()
        begin()
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
        } else if (!editing && event.key === 'F2') {
          event.preventDefault()
          event.stopPropagation()
          begin()
        } else if (!editing && (event.key === 'Enter' || event.key === ' ')) {
          clearClick()
          event.preventDefault()
          event.stopPropagation()
          activate({ pointer: false })
        }
      }}
    >{initial.current}
    </div>
  )
}

import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { Button } from '../components/ui/controls.tsx'
import { Icon } from '../components/ui/icon.tsx'
import type { ChipKind } from './draft.ts'

// Something the @ picker can reference: an attachment of this message, a project or a task.
export interface MentionItem {
  key: string
  kind: ChipKind
  title: string
  detail: string
  excerpt?: string
  insert: string
  // A column or task shows its own icons in its column's color.
  icons?: string[]
  tone?: string
}

export function MentionPicker({
  id,
  matches,
  active,
  choose,
  anchor,
}: {
  id: string
  anchor: RefObject<HTMLTextAreaElement | null>
  matches: MentionItem[]
  active: number
  choose({ item }: { item: MentionItem }): void
}) {
  const root = useRef<HTMLDivElement>(null)
  useLayoutEffect(
    () => {
      const element = root.current

      if (!element) {
        return
      }

      element.showPopover()

      const position = () => {
        const bounds = anchor.current?.getBoundingClientRect()

        if (!bounds) {
          return
        }

        const above = bounds.top > innerHeight - bounds.bottom
        element.style.width = `${Math.min(
          bounds.width,
          innerWidth - 16,
        )}px`
        element.style.maxHeight = `${Math.min(
          320,
          Math.max(
            80,
            (above ? bounds.top : innerHeight - bounds.bottom) - 16,
          ),
        )}px`
        element.style.left = `${Math.max(
          8,
          Math.min(
            bounds.left,
            innerWidth - element.offsetWidth - 8,
          ),
        )}px`
        element.style.top = `${Math.max(
          8,
          above ? bounds.top - element.offsetHeight - 8 : bounds.bottom + 8,
        )}px`
      }

      position()
      const observer = new ResizeObserver(position)
      observer.observe(element)
      window.addEventListener(
        'resize',
        position,
      )
      document.addEventListener(
        'scroll',
        position,
        true,
      )

      return () => {
        observer.disconnect(); window.removeEventListener(
          'resize',
          position,
        )
        document.removeEventListener(
          'scroll',
          position,
          true,
        )
      }
    },
    [anchor],
  )
  useEffect(
    () => {
      document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: 'nearest' })
    },
    [
      id,
      active,
    ],
  )

  return (
    <div
      ref={root}
      popover="manual"
      className="mention-menu"
      onMouseDown={event => event.preventDefault()}
    >
      <span className="eyebrow">Mention · Tab or Enter picks</span>
      <div id={id} role="listbox" aria-label="Mention">
        {matches.map((
          item,
          index,
        ) => (
          <Button
            key={item.key}
            id={`${id}-${index}`}
            role="option"
            aria-selected={index === active}
            className={index === active ? 'active' : ''}
            tabIndex={-1}
            onClick={() => choose({ item })}
          >
            <span className="mention-heading">
              <span className={`mention-icon ${item.tone ?? ''}`}>
                {(item.icons ?? [item.kind]).map(icon => <Icon key={icon} name={icon} size={14} />)}
              </span>
              <strong>{item.title}</strong>
              <small>{item.detail}</small>
            </span>
            {item.excerpt && <span className="mention-excerpt">{item.excerpt}</span>}
          </Button>
        ))}
      </div>
      {!matches.length && <p role="status">Nothing in this Hydra matches.</p>}
    </div>
  )
}

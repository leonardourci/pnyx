import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { Button } from './controls.tsx'
import { Icon } from './icon.tsx'
import type { ReactNode } from 'react'

export interface PickerItem {
  key: string
  title: string
  detail: string
  excerpt?: string
  icons?: string[]
  tone?: string
  group?: string
  badge?: ReactNode
  disabled?: boolean
}

export function SuggestionPicker<T extends PickerItem>({
  id,
  matches,
  active,
  choose,
  anchor,
  label,
  loading = false,
  empty = 'Nothing in this Hydra matches.',
  footer,
  className = '',
}: {
  id: string
  anchor: RefObject<HTMLTextAreaElement | null>
  matches: T[]
  active: number
  choose({ item }: { item: T }): void
  label: string
  loading?: boolean
  empty?: string
  footer?: ReactNode
  className?: string
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

      if (anchor.current) {
        observer.observe(anchor.current)
      }

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
      className={`mention-menu ${className}`}
      onMouseDown={event => event.preventDefault()}
    >
      <span className="eyebrow">{label} · Tab or Enter picks</span>
      <div id={id} role="listbox" aria-label={label}>
        {matches.map((
          item,
          index,
        ) => (
          <div key={item.key}>
            {item.group && item.group !== matches[index - 1]?.group && <span className="picker-group">{item.group}</span>}
            <Button
              id={`${id}-${index}`}
              role="option"
              aria-selected={index === active}
              className={index === active ? 'active' : ''}
              tabIndex={-1}
              disabled={item.disabled}
              onClick={() => choose({ item })}
            >
              <span className="mention-heading">
                <span className={`mention-icon ${item.tone ?? ''}`}>
                  {(item.icons ?? ['star']).map(icon => <Icon key={icon} name={icon} size={14} />)}
                </span>
                {item.badge && <span className="picker-project">{item.badge}</span>}
                <strong>{item.title}</strong>
                <small>{item.detail}</small>
              </span>
              {item.excerpt && <span className="mention-excerpt">{item.excerpt}</span>}
            </Button>
          </div>
        ))}
      </div>
      {!matches.length && <p role="status">{loading ? 'Loading…' : empty}</p>}
      {footer}
    </div>
  )
}

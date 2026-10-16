import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import type { Card } from '../../../src/core/model.ts'
import { Button } from '../components/ui/controls.tsx'

export function MentionPicker({ id, matches, active, choose, anchor }: {
  id: string
  anchor: RefObject<HTMLTextAreaElement | null>
  matches: { card: Card; excerpt: string }[]
  active: number
  choose({ card }: { card: Card }): void
}) {
  const root = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
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
      element.style.width = `${Math.min(bounds.width, innerWidth - 16)}px`
      element.style.maxHeight = `${Math.min(320, Math.max(80, (above ? bounds.top : innerHeight - bounds.bottom) - 16))}px`
      element.style.left = `${Math.max(8, Math.min(bounds.left, innerWidth - element.offsetWidth - 8))}px`
      element.style.top = `${Math.max(8, above ? bounds.top - element.offsetHeight - 8 : bounds.bottom + 8)}px`
    }

    position()
    const observer = new ResizeObserver(position)
    observer.observe(element)
    window.addEventListener('resize', position)
    document.addEventListener('scroll', position, true)

    return () => {
      observer.disconnect(); window.removeEventListener('resize', position)
      document.removeEventListener('scroll', position, true)
    }
  }, [anchor])
  useEffect(() => {
    document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: 'nearest' })
  }, [id, active])

  return (
    <div
      ref={root}
      popover="manual"
      className="mention-menu"
      onMouseDown={event => event.preventDefault()}
    >
      <span className="eyebrow">Tasks in this Hydra</span>
      <div id={id} role="listbox" aria-label="Mention a task">
        {matches.map(({ card, excerpt }, index) => (
          <Button
            key={card.id}
            id={`${id}-${index}`}
            role="option"
            aria-selected={index === active}
            className={index === active ? 'active' : ''}
            tabIndex={-1}
            onClick={() => choose({ card })}
          >
            <span className="mention-heading"><strong>{card.title}</strong><small>{card.project || 'No project'}</small></span>
            <span className="mention-excerpt">{excerpt}</span>
          </Button>
        ))}
      </div>
      {!matches.length && <p role="status">No matching tasks in this Hydra.</p>}
    </div>
  )
}

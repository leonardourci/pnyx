import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Markdown } from './markdown.tsx'
import { Icon } from './icon.tsx'
import { Button } from './controls.tsx'

export function Disclosure({
  title,
  children,
  className = '',
}: {
  title: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <details className={`disclosure ${className}`}>
      <summary contentEditable={false}>
        {title}
        <span className="disclosure-chevron" aria-hidden="true"><Icon name="chevron_right" size={14} /></span>
      </summary>
      <div className="disclosure-body">{children}</div>
    </details>
  )
}

export function CollapsibleText({
  text,
  className = '',
}: {
  text: string
  className?: string
}) {
  const [
      expanded,
      setExpanded,
    ] = useState(false), [
      long,
      setLong,
    ] = useState(false), id = useId()
  const preview = useRef<HTMLDivElement>(null)

  useLayoutEffect(
    () => {
      const element = preview.current

      if (!element || expanded) {
        return
      }

      const measure = () => setLong(element.scrollHeight > element.clientHeight + 1)
      measure()
      const observer = new ResizeObserver(measure)
      observer.observe(element)

      return () => observer.disconnect()
    },
    [
      text,
      expanded,
    ],
  )

  return (
    <div className={`collapsible-text ${className}`}>
      <div id={id} ref={preview} className={expanded ? undefined : 'text-preview'}><Markdown text={text} /></div>
      {(long || expanded) && (
        <Button
          contentEditable={false}
          className="show-more"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? 'Show less' : 'Show more'}
        </Button>
      )}
    </div>
  )
}

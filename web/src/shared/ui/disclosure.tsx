import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { RichText } from './rich-text.tsx'
import { attachmentSource } from '#web-hydra/attached-image.tsx'
import { shownImageNames } from '#hydra/images.ts'
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
  images = true,
}: {
  text: string
  className?: string
  // A closed card stays compact: its image chips keep their thumbnails and the card opens to the rest.
  images?: boolean
}) {
  const [
      expanded,
      setExpanded,
    ] = useState(false), [
      long,
      setLong,
    ] = useState(false), id = useId()
  const preview = useRef<HTMLDivElement>(null)
  // Folded text shows image chips; a picture the Hydra serves shows in its place once expanded.
  const served = [...shownImageNames({ text }).keys()].some(path => attachmentSource({ path }))
  const pictures = images && served

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
      <div id={id} ref={preview} className={expanded ? undefined : 'text-preview'}><RichText text={text} images={expanded} /></div>
      {(long || pictures || expanded) && (
        <Button
          contentEditable={false}
          className="show-more"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? 'Show less' : pictures && !long ? 'Show images' : 'Show more'}
        </Button>
      )}
    </div>
  )
}

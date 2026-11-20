import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { RichText } from './rich-text.tsx'
import { DisclosureChevron } from './disclosure-chevron.tsx'
import { Button } from './controls.tsx'

export function Disclosure({
  title,
  children,
  className = '',
  open,
  onToggle,
  leading = false,
}: {
  title: ReactNode | (({ open }: { open: boolean }) => ReactNode)
  children: ReactNode
  className?: string
  open?: boolean
  leading?: boolean
  onToggle?({ open }: { open: boolean }): void
}) {
  const [
    nativeOpen,
    setNativeOpen,
  ] = useState(open ?? false)
  const expanded = nativeOpen
  const summaryPadding = leading ? 'pl-3.5' : 'pr-5'
  const position = leading ? 'left-0 text-inherit' : 'right-0.5 text-muted'

  return (
    <details
      className={`disclosure ${className}`}
      open={open}
      onToggle={event => {
        const opened = event.currentTarget.open
        setNativeOpen(opened)
        onToggle?.({ open: opened })
      }}
    >
      <summary className={`relative cursor-pointer list-none text-ui in-[.ask]:py-0.75 [&::-webkit-details-marker]:hidden ${summaryPadding}`} contentEditable={false}>
        {typeof title === 'function' ? title({ open: expanded }) : title}
        <span className={`disclosure-chevron absolute top-0 ${position}`} aria-hidden="true"><DisclosureChevron expanded={expanded} /></span>
      </summary>
      <div className="disclosure-body pt-2">{children}</div>
    </details>
  )
}

type Control = {
  open?: undefined
  toggle?: undefined
} | {
  open: boolean
  toggle(): void
}

// preview: shown while folded, so the rest of text renders only once opened. open and toggle let a caller own the state.
export function CollapsibleText({
  text,
  preview: folded,
  open,
  toggle,
  measured,
  className = '',
}: {
  text: string
  preview?: string
  // Tells the caller whether the text folds away anything.
  measured?({ long }: { long: boolean }): void
  className?: string
} & Control) {
  const [
      own,
      setOwn,
    ] = useState(false), [
      overflowing,
      setOverflowing,
    ] = useState(false), id = useId()
  const expanded = open ?? own
  const flip = toggle ?? (() => setOwn(!own))
  const shown = expanded || folded === undefined ? text : folded
  const long = overflowing || shown !== text

  useEffect(
    () => measured?.({ long }),
    [
      measured,
      long,
    ],
  )
  const preview = useRef<HTMLDivElement>(null)

  useLayoutEffect(
    () => {
      const element = preview.current

      if (!element || expanded) {
        return
      }

      const measure = () => setOverflowing(element.scrollHeight > element.clientHeight + 1)
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
    <div className={`collapsible-text in-[.card]:max-w-full in-[.card]:min-w-0 ${className}`}>
      <div id={id} ref={preview} className={expanded ? undefined : 'text-preview line-clamp-3 max-h-disclosure text-chat leading-(--chat-line)'}><RichText text={shown} /></div>
      {(long || expanded) && (
        <Button
          contentEditable={false}
          className="show-more min-h-0 justify-self-start p-0 text-meta font-semibold text-gold"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={flip}
        >
          {expanded ? 'Show less' : 'Show more'}
        </Button>
      )}
    </div>
  )
}

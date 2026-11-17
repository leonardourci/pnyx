import { FloatingPanel } from './floating-panel.tsx'
import { suggestionMatch, type SuggestionMatch } from '#hydra/suggestion-matches.ts'
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { Button } from './controls.tsx'
import { Icon } from './icon.tsx'
import type { ReactNode } from 'react'

export interface PickerItem {
  key: string
  title: string
  detail: string
  excerpt?: string
  excerptHighlights?: SuggestionMatch['ranges']
  icons?: string[]
  tone?: string
  group?: string
  badge?: ReactNode
  disabled?: boolean
}

function MatchedText({
  text,
  query,
  ranges,
}: {
  text: string
  query: string
  ranges?: SuggestionMatch['ranges']
}) {
  const highlights = ranges ?? suggestionMatch({
    name: text,
    query,
  })?.ranges ?? []

  if (!highlights.length) {
    return text
  }

  const parts: ReactNode[] = []
  let cursor = 0

  for (const {
    from,
    to,
  } of highlights) {
    if (from < cursor) {
      continue
    }

    parts.push(
      text.slice(
        cursor,
        from,
      ),
      <mark key={from}>{text.slice(
        from,
        to,
      )}
      </mark>,
    )
    cursor = to
  }

  parts.push(text.slice(cursor))

  return parts
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
  query = '',
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
  query?: string
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
    <FloatingPanel
      ref={root}
      popover="manual"
      className={`mention-menu group/suggestions max-h-80 border-gold-line! rounded-panel p-2.5 z-8 shadow-suggestions [&_mark]:p-0 [&_mark]:rounded-sm [&_mark]:text-inherit [&_mark]:bg-comment-emphasis [&_p]:text-muted [&_p]:text-meta ${className}`}
      // eslint-disable-next-line pnyx/object-params -- React owns the pointer event signature.
      onMouseDown={event => event.preventDefault()}
    >
      <span className="eyebrow">{label} · Tab or Enter picks</span>
      <div id={id} role="listbox" aria-label={label}>
        {matches.map((
          item,
          index,
        ) => (
          <div key={item.key}>
            {item.group && item.group !== matches[index - 1]?.group && <span className="picker-group block px-2.5 pt-2 pb-1 text-muted text-meta">{item.group}</span>}
            <Button
              id={`${id}-${index}`}
              role="option"
              aria-selected={index === active}
              className={`flex flex-col items-stretch w-full gap-1 text-left p-2 group-[.slash-menu]/suggestions:gap-3 group-[.slash-menu]/suggestions:[&>span]:flex-1 group-[.slash-menu]/suggestions:[&>span]:text-ui group-[.slash-menu]/suggestions:[&>span]:text-muted ${index === active ? 'active bg-hover' : ''}`}
              tabIndex={-1}
              disabled={item.disabled}
              onClick={() => choose({ item })}
            >
              <span className="mention-heading flex items-center gap-2 min-w-0 [&>strong]:flex-1 [&>strong]:min-w-0 [&>strong]:wrap-anywhere [&>small]:shrink [&>small]:min-w-0 [&>small]:max-w-[45%] [&>small]:truncate [&>small]:text-muted [&>small]:text-meta group-[.slash-menu]/suggestions:items-start group-[.slash-menu]/suggestions:[&_small]:block group-[.slash-menu]/suggestions:[&_small]:mt-0.75">
                <span className={`mention-icon inline-flex text-(--column-color,currentColor) group-[.slash-menu]/suggestions:items-center group-[.slash-menu]/suggestions:h-[1lh] ${item.tone ?? ''}`}>
                  {(item.icons ?? ['star']).map(icon => <Icon key={icon} name={icon} size={14} />)}
                </span>
                {item.badge && <span className="picker-project flex-[0_1_auto] max-w-[42%] min-w-0 [&_.task-label]:text-meta">{item.badge}</span>}
                <strong><MatchedText text={item.title} query={query} /></strong>
                <small>{item.detail}</small>
              </span>
              {item.excerpt && <span className="mention-excerpt whitespace-normal wrap-anywhere text-muted text-meta group-[.slash-menu]/suggestions:truncate"><MatchedText text={item.excerpt} query={query} ranges={item.excerptHighlights} /></span>}
            </Button>
          </div>
        ))}
      </div>
      {!matches.length && <p role="status">{loading ? 'Loading…' : empty}</p>}
      {footer}
    </FloatingPanel>
  )
}

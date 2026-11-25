import { applyRuntimeStyle } from './runtime-style.ts'
import { FloatingPanel } from './floating-panel.tsx'
import type { RowMatch } from '#titan/suggestion-matches.ts'
import { useStableActions } from '#web-shared/stable.ts'
import { memo, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { Button } from './controls.tsx'
import { ICON_SIZE, Icon } from '#web-shared/icons.tsx'
import type { ReactNode } from 'react'

// Rows rendered at first and added per scroll step; the panel shows about eight at its full height.
const ROW_WINDOW = 40
// Arrowing keeps this many rows rendered past the active one, so the next ones are there to scroll to.
const ROWS_AHEAD = 10
const EXCERPT_BEFORE = 48
const EXCERPT_LENGTH = 180

type Range = RowMatch<unknown>['ranges'][number]

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

function MatchedText({
  text,
  ranges,
}: {
  text: string
  ranges: Range[]
}) {
  if (!ranges.length) {
    return text
  }

  const parts: ReactNode[] = []
  let cursor = 0

  for (const {
    from,
    to,
  } of ranges) {
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

// A long excerpt shows the part around its first match, with the ranges moved into the cut text.
function excerptAround({
  text,
  ranges,
}: {
  text: string
  ranges: Range[]
}) {
  const start = Math.max(
    0,
    (ranges[0]?.from ?? 0) - EXCERPT_BEFORE,
  )
  const end = start + EXCERPT_LENGTH
  const leading = start ? '…' : ''
  const shift = leading.length - start

  return {
    text: `${leading}${text.slice(
      start,
      end,
    )}${text.length > end ? '…' : ''}`,
    ranges: ranges.filter(range => range.from >= start && range.to <= end).map(range => ({
      from: range.from + shift,
      to: range.to + shift,
    })),
  }
}

const sameRanges = ({
  a,
  b,
}: {
  a: Range[]
  b: Range[]
}) => a.length === b.length && a.every((
  range,
  index,
) => range.from === b[index]!.from && range.to === b[index]!.to)

interface RowProps {
  id: string
  match: RowMatch<PickerItem>
  active: boolean
  heading?: string
  choose({ item }: { item: PickerItem }): void
}

const sameRow = ({
  before,
  after,
}: {
  before: RowProps
  after: RowProps
}) => before.id === after.id && before.active === after.active && before.heading === after.heading
  && before.match.row === after.match.row && before.match.context === after.match.context
  && sameRanges({
    a: before.match.ranges,
    b: after.match.ranges,
  })

// A row renders again only when its source row, its match, its heading or whether it is active changed.
const PickerRow = memo(
  ({
    id,
    match,
    active,
    heading,
    choose,
  }: RowProps) => {
    const item = match.row.item
    const titleRanges = match.context ? [] : match.ranges
    const contextText = match.context ? match.row.fallbackText : undefined
    const excerpt = contextText ?? item.excerpt
    const shown = excerpt === undefined ? undefined : excerptAround({
      text: excerpt,
      ranges: contextText === undefined ? [] : match.ranges,
    })

    return (
      <div>
        {heading && <span className="picker-group block px-2.5 pt-2 pb-1 text-meta text-muted">{heading}</span>}
        <Button
          id={id}
          role="option"
          aria-selected={active}
          className={`flex w-full flex-col items-stretch gap-1 p-2 text-left group-[.slash-menu]/suggestions:gap-3 group-[.slash-menu]/suggestions:[&>span]:flex-1 group-[.slash-menu]/suggestions:[&>span]:text-ui group-[.slash-menu]/suggestions:[&>span]:text-muted ${active ? 'active bg-hover' : ''}`}
          tabIndex={-1}
          disabled={item.disabled}
          onClick={() => choose({ item })}
        >
          <span className="mention-heading flex min-w-0 items-center gap-2 group-[.slash-menu]/suggestions:items-start group-[.slash-menu]/suggestions:[&_small]:mt-0.75 group-[.slash-menu]/suggestions:[&_small]:block [&>small]:max-w-option-meta [&>small]:min-w-0 [&>small]:shrink [&>small]:truncate [&>small]:text-meta [&>small]:text-muted [&>strong]:min-w-0 [&>strong]:flex-1 [&>strong]:wrap-anywhere">
            <span className={`mention-icon inline-flex text-(--column-color,currentColor) group-[.slash-menu]/suggestions:h-line group-[.slash-menu]/suggestions:items-center ${item.tone ?? ''}`}>
              {(item.icons ?? ['star']).map(icon => <Icon key={icon} name={icon} size={ICON_SIZE.inline} />)}
            </span>
            {item.badge && <span className="picker-project max-w-picker-badge min-w-0 flex-chip [&_.task-label]:text-meta">{item.badge}</span>}
            <strong><MatchedText text={item.title} ranges={titleRanges} /></strong>
            <small>{item.detail}</small>
          </span>
          {shown && <span className="mention-excerpt text-meta wrap-anywhere whitespace-normal text-muted group-[.slash-menu]/suggestions:truncate"><MatchedText {...shown} /></span>}
        </Button>
      </div>
    )
  },
  // eslint-disable-next-line othrys/object-params -- React owns memo's comparison signature.
  (
    before,
    after,
  ) => sameRow({
    before,
    after,
  }),
)

export function SuggestionPicker<T extends PickerItem>({
  id,
  matches,
  active,
  choose,
  anchor,
  label,
  loading = false,
  empty = 'Nothing in this Titan matches.',
  footer,
  className = '',
}: {
  id: string
  anchor: RefObject<HTMLTextAreaElement | null>
  matches: RowMatch<T>[]
  active: number
  choose({ item }: { item: T }): void
  label: string
  loading?: boolean
  empty?: string
  footer?: ReactNode
  className?: string
}) {
  const [
    rendered,
    setRendered,
  ] = useState(ROW_WINDOW)
  const shown = Math.max(
    rendered,
    active + ROWS_AHEAD,
  )
  const sentinel = useRef<HTMLDivElement>(null)
  // Rows keep one choose callback, which always calls the latest one the field passed.
  const { chooseRow } = useStableActions({
    actions: { chooseRow: ({ item }: { item: PickerItem }) => choose({ item: item as T }) },
  })
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
        applyRuntimeStyle({
          element,
          values: {
            width: Math.min(
              bounds.width,
              innerWidth - 16,
            ),
            maxHeight: Math.min(
              320,
              Math.max(
                80,
                (above ? bounds.top : innerHeight - bounds.bottom) - 16,
              ),
            ),
          },
        })
        applyRuntimeStyle({
          element,
          values: {
            left: Math.max(
              8,
              Math.min(
                bounds.left,
                innerWidth - element.offsetWidth - 8,
              ),
            ),
            top: Math.max(
              8,
              above ? bounds.top - element.offsetHeight - 8 : bounds.bottom + 8,
            ),
          },
        })
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

  const more = matches.length > shown
  useEffect(
    () => {
      const element = sentinel.current

      if (!more || !element) {
        return
      }

      const observer = new IntersectionObserver(
        entries => {
          if (entries.some(entry => entry.isIntersecting)) {
            setRendered(rows => rows + ROW_WINDOW)
          }
        },
        { root: root.current },
      )
      observer.observe(element)

      return () => observer.disconnect()
    },
    [
      more,
      shown,
    ],
  )

  return (
    <FloatingPanel
      ref={root}
      popover="manual"
      className={`mention-menu group/suggestions z-8 max-h-80 rounded-panel border-gold-line! p-2.5 shadow-suggestions [&_mark]:rounded-sm [&_mark]:bg-comment-emphasis [&_mark]:p-0 [&_mark]:text-inherit [&_p]:text-meta [&_p]:text-muted ${className}`}
      // eslint-disable-next-line othrys/object-params -- React owns the pointer event signature.
      onMouseDown={event => event.preventDefault()}
    >
      <span className="eyebrow">{label} · Tab or Enter picks</span>
      <div id={id} role="listbox" aria-label={label}>
        {matches.slice(
          0,
          shown,
        ).map((
          match,
          index,
        ) => {
          const group = match.row.item.group
          const heading = group && group !== matches[index - 1]?.row.item.group ? group : undefined

          return (
            <PickerRow
              key={match.row.key}
              id={`${id}-${index}`}
              match={match}
              active={index === active}
              heading={heading}
              choose={chooseRow}
            />
          )
        })}
        {matches.length > shown && <div ref={sentinel} className="picker-more h-px" />}
      </div>
      {!matches.length && <p role="status">{loading ? 'Loading…' : empty}</p>}
      {footer}
    </FloatingPanel>
  )
}

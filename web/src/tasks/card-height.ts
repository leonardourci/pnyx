import { useEffect, useLayoutEffect, useState, type RefObject } from 'react'

const PANEL_MINIMUM = 120
// A tab still reading its first content keeps the card's last bounds, so the card never shrinks to a loading line and grows back.
const LOADING = '.card-panel:not([hidden]) :is(.task-updates, .task-report)[aria-busy="true"]'

const spacing = ({ element }: { element: HTMLElement }) => {
  const css = getComputedStyle(element)

  return parseFloat(css.paddingTop) + parseFloat(css.paddingBottom)
    + parseFloat(css.borderTopWidth) + parseFloat(css.borderBottomWidth)
}

const rows = ({ element }: { element: HTMLElement }) => [...element.children]
  .filter((child): child is HTMLElement => child instanceof HTMLElement
    && getComputedStyle(child).display !== 'none')

const outerHeight = ({ element }: { element: HTMLElement }) => {
  const css = getComputedStyle(element)

  return element.getBoundingClientRect().height
    + parseFloat(css.marginTop) + parseFloat(css.marginBottom)
}

const naturalHeight = ({ element }: { element: HTMLElement }) => {
  const children = rows({ element })
  const gap = parseFloat(getComputedStyle(element).rowGap) || 0

  return spacing({ element }) + gap * Math.max(
    0,
    children.length - 1,
  ) + children.reduce(
    (
      height,
      child,
    ) => height + outerHeight({ element: child }),
    0,
  )
}

export function useCardHeight({
  element,
  selected,
}: {
  element: RefObject<HTMLElement | null>
  selected: boolean
}) {
  const [
    bounds,
    setBounds,
  ] = useState({
    measured: false,
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
    available: 0,
    // One line of the shown text, so a closed card shows whole lines.
    line: 0,
  })
  useLayoutEffect(
    () => {
      const card = element.current
      const column = card?.closest<HTMLElement>('.column-cards')
      const content = card?.querySelector<HTMLElement>('.card-content')

      if (!card || !column || !content) {
        return
      }

      const measure = () => {
        if (card.querySelector(LOADING)) {
          return
        }

        const children = rows({ element: content })
        const gap = parseFloat(getComputedStyle(content).rowGap) || 0
        let minimum = spacing({ element: card }) + gap * Math.max(
          0,
          children.length - 1,
        )
        let maximum = minimum
        let shownLine = 0

        for (const child of children) {
          if (child.classList.contains('card-panel')) {
            // A tab's body scrolls, so it needs only a few lines to stay usable.
            const full = naturalHeight({ element: child })
            minimum += Math.min(
              full,
              PANEL_MINIMUM,
            )
            maximum += full
          } else if (child.classList.contains('card-rest')) {
            const update = child.querySelector<HTMLElement>('.last-message')
            const text = update?.querySelector<HTMLElement>('.text-preview') ?? update
            const full = naturalHeight({ element: child })
            const line = text ? parseFloat(getComputedStyle(text).lineHeight) : full
            shownLine = text ? line : shownLine
            minimum += child.querySelector('form') ? full : Math.min(
              full,
              line,
            )
            maximum += full
          } else {
            const height = outerHeight({ element: child })
            minimum += height
            maximum += height
          }
        }

        const next = {
          measured: true,
          line: shownLine,
          minimum: Math.ceil(minimum),
          maximum: Math.ceil(Math.max(
            minimum,
            maximum,
          )),
          available: column.clientHeight - spacing({ element: column }),
        }
        setBounds(old => old.measured && old.minimum === next.minimum
          && old.maximum === next.maximum
          && old.available === next.available && old.line === next.line ? old : next)
      }

      let frame = 0

      const schedule = () => {
        cancelAnimationFrame(frame)
        frame = requestAnimationFrame(measure)
      }

      measure()
      const resize = new ResizeObserver(schedule)

      const watch = () => {
        resize.disconnect()
        resize.observe(column)
        resize.observe(content)
        card.querySelectorAll('.last-message, .task-updates > *, .task-requests, .card-panel > *')
          .forEach(child => resize.observe(child))
      }

      watch()
      const mutations = new MutationObserver(() => {
        watch()
        schedule()
      })
      mutations.observe(
        card,
        {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true,
          // A tab switch shows one panel and hides the other.
          attributeFilter: [
            'open',
            'hidden',
            'data-tab',
            'aria-busy',
          ],
        },
      )

      let disposed = false

      const afterFonts = async () => {
        await document.fonts.ready

        if (!disposed) {
          schedule()
        }
      }

      void afterFonts()

      return () => {
        disposed = true
        cancelAnimationFrame(frame); resize.disconnect(); mutations.disconnect()
      }
    },
    [
      element,
      selected,
    ],
  )

  return bounds
}

// How far a field typed in inside the card has grown since it took focus; the card grows by as much.
export function useTypingGrowth({ element }: { element: RefObject<HTMLElement | null> }) {
  const [
    growth,
    setGrowth,
  ] = useState(0)

  useEffect(
    () => {
      const card = element.current

      if (!card) {
        return
      }

      let watching: ResizeObserver | undefined

      const start = (event: FocusEvent) => {
        const field = event.target instanceof HTMLTextAreaElement && event.target.closest('.composer-field')
          ? event.target : null

        if (!field) {
          return
        }

        watching?.disconnect()
        const base = field.offsetHeight
        watching = new ResizeObserver(() => setGrowth(Math.max(
          0,
          field.offsetHeight - base,
        )))
        watching.observe(field)
      }

      const stop = (event: FocusEvent) => {
        if (event.relatedTarget instanceof Node && card.contains(event.relatedTarget)) {
          return
        }

        watching?.disconnect()
        setGrowth(0)
      }

      card.addEventListener(
        'focusin',
        start,
      )
      card.addEventListener(
        'focusout',
        stop,
      )

      return () => {
        watching?.disconnect()
        card.removeEventListener(
          'focusin',
          start,
        )
        card.removeEventListener(
          'focusout',
          stop,
        )
      }
    },
    [element],
  )

  return growth
}

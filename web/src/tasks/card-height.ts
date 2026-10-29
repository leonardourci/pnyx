import { useLayoutEffect, useState, type RefObject } from 'react'

const PANEL_MINIMUM = 120

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

const naturalHeight = ({ element }: { element: HTMLElement }) => spacing({ element })
  + rows({ element }).reduce(
    (
      height,
      child,
    ) => height + outerHeight({ element: child }),
    0,
  )

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
        const children = rows({ element: content })
        const gap = parseFloat(getComputedStyle(content).rowGap) || 0
        let minimum = spacing({ element: card }) + gap * Math.max(
          0,
          children.length - 1,
        )
        let maximum = minimum

        for (const child of children) {
          if (child.classList.contains('card-panel')) {
            // An open card's tab scrolls, so it needs only a few lines to stay usable.
            const full = naturalHeight({ element: child })
            minimum += Math.min(
              full,
              PANEL_MINIMUM,
            )
            maximum += full
          } else if (child.classList.contains('card-rest')) {
            const update = child.querySelector<HTMLElement>('.last-message')
            const full = naturalHeight({ element: child })
            const line = update ? parseFloat(getComputedStyle(update).lineHeight) : full
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

        const detail = card.querySelector<HTMLElement>('.detail')

        if (selected && detail) {
          const updates = detail.querySelector<HTMLElement>('.task-updates')
          const full = updates ? naturalHeight({ element: updates }) : 0
          const other = rows({ element: detail }).filter(child => child !== updates)
            .reduce(
              (
                height,
                child,
              ) => height + outerHeight({ element: child }),
              0,
            )
          const frame = spacing({ element: detail })
            + parseFloat(getComputedStyle(detail).marginTop)
          + (parseFloat(getComputedStyle(card).rowGap) || 0) + other
          minimum += frame + Math.min(
            80,
            full,
          )
          maximum += frame + full
        }

        const next = {
          measured: true,
          minimum: Math.ceil(minimum),
          maximum: Math.ceil(Math.max(
            minimum,
            maximum,
          )),
          available: column.clientHeight - spacing({ element: column }),
        }
        setBounds(old => old.measured && old.minimum === next.minimum
          && old.maximum === next.maximum
          && old.available === next.available ? old : next)
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
          // A tab switch shows a panel and hides the updates list.
          attributeFilter: [
            'open',
            'hidden',
            'data-tab',
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

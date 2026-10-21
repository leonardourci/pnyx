import { useLayoutEffect, useState, type RefObject } from 'react'

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
          if (child.classList.contains('card-rest')) {
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
          minimum: Math.ceil(minimum),
          maximum: Math.ceil(Math.max(
            minimum,
            maximum,
          )),
          available: column.clientHeight - spacing({ element: column }),
        }
        setBounds(old => old.minimum === next.minimum && old.maximum === next.maximum
          && old.available === next.available ? old : next)
      }

      let frame = 0

      const schedule = () => {
        cancelAnimationFrame(frame)
        frame = requestAnimationFrame(measure)
      }

      measure()
      const resize = new ResizeObserver(schedule)
      resize.observe(column)
      resize.observe(content)
      const mutations = new MutationObserver(schedule)
      mutations.observe(
        card,
        {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true,
          attributeFilter: ['open'],
        },
      )
      void document.fonts.ready.then(schedule)

      return () => {
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

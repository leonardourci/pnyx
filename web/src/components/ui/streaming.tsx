import { useEffect, useState, type ComponentProps } from 'react'
import { Markdown } from './markdown.tsx'

export function MessageText({
  streaming,
  text,
  ...props
}: ComponentProps<typeof Markdown> & {
  streaming?: boolean
}) {
  const [
    shown,
    setShown,
  ] = useState(text)
  const [
    reduced,
    setReduced,
  ] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches)

  useEffect(
    () => {
      const media = matchMedia('(prefers-reduced-motion: reduce)')
      const change = () => setReduced(media.matches)
      media.addEventListener(
        'change',
        change,
      )

      return () => media.removeEventListener(
        'change',
        change,
      )
    },
    [],
  )

  useEffect(
    () => {
      if (!streaming || reduced) {
        setShown(text)

        return
      }

      let frame = 0, visible = text.startsWith(shown) ? shown.length : 0

      const reveal = () => {
        let end = Math.min(
          text.length,
          visible + Math.max(
            1,
            Math.ceil((text.length - visible) / 3),
          ),
        )

        if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? '')) {
          end++
        }

        visible = end
        setShown(text.slice(
          0,
          end,
        ))

        if (end < text.length) {
          frame = requestAnimationFrame(reveal)
        }
      }

      frame = requestAnimationFrame(reveal)

      return () => cancelAnimationFrame(frame)
    },
    [
      text,
      streaming,
      reduced,
    ],
  )

  return <Markdown {...props} text={!streaming || reduced ? text : shown} />
}

export function Working({ label = 'Working' }: { label?: string }) {
  return <p className="reply-working" role="status"><span className="working-dots" aria-hidden="true"><i /><i /><i /></span>{label}</p>
}

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { Button } from '../shared/ui/controls.tsx'
import type { ChatComment } from './chat.ts'
import { HIGHLIGHT_SUPPORTED, commentRanges, fadeHighlight } from './comment-highlight.ts'
import { CommentNumber } from './comment-number.tsx'
import { COMMENT_BADGE_SIZE, commentPileLayout, commentPiles } from './comment-piles.ts'
import { COMMENT_FOCUS, COMMENT_REVEAL } from './comment-motion.ts'
import { revealComment } from './comment-reveal.ts'

const JUMP_DURATION = 1800
type Rect = {
  top: number
  left: number
  width: number
  height: number
}
type Pile = ReturnType<typeof commentPiles>[number]

function CommentPile({
  pile,
  width,
  active,
  show,
  hover,
}: {
  pile: Pile
  width: number
  active: string | null
  show({ id }: { id: string }): void
  hover({ id }: { id: string | null }): void
}) {
  const [
    spread,
    setSpread,
  ] = useState(false)
  const layout = commentPileLayout({
    count: pile.badges.length,
    active: pile.badges.findIndex(badge => badge.key === active),
    spread,
  })

  return (
    <div
      className="comment-pile"
      data-spread={spread || undefined}
      aria-label={`${pile.badges.length} comment markers`}
      style={{
        top: pile.top,
        left: Math.max(
          0,
          Math.min(
            pile.left,
            width - layout.width,
          ),
        ),
        width: layout.width,
        height: COMMENT_BADGE_SIZE,
      }}
      onPointerEnter={() => setSpread(true)}
      onPointerLeave={event => {
        if (!event.currentTarget.contains(document.activeElement)) {
          setSpread(false)
        }
      }}
      onFocus={() => setSpread(true)}
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setSpread(false)
        }
      }}
    >
      {pile.badges.map((
        badge,
        index,
      ) => (
        <Button
          key={badge.key}
          className="comment-marker"
          data-comment-marker={badge.key}
          data-active={active === badge.key || undefined}
          aria-label={`Go to comment ${badge.number}`}
          style={{
            ...layout.positions[index],
            width: COMMENT_BADGE_SIZE,
            minHeight: COMMENT_BADGE_SIZE,
            height: COMMENT_BADGE_SIZE,
          }}
          onPointerEnter={() => hover({ id: badge.key })}
          onPointerLeave={() => hover({ id: null })}
          onFocus={() => hover({ id: badge.key })}
          onBlur={() => hover({ id: null })}
          onMouseDown={event => event.preventDefault()}
          onClick={() => show({ id: badge.key })}
        >
          <CommentNumber number={badge.number} />
        </Button>
      ))}
    </div>
  )
}

export function CommentAnnotations({
  host,
  comments,
  highlight,
}: {
  highlight: string
  host: RefObject<HTMLDivElement | null>
  comments: ChatComment[]
}) {
  const layer = useRef<HTMLDivElement>(null)
  const [
    layout,
    setLayout,
  ] = useState<{
    piles: Pile[]
    rects: Rect[]
    width: number
  }>({
    piles: [],
    rects: [],
    width: 0,
  })
  const [
    active,
    setActive,
  ] = useState<string | null>(null)
  const [
    hovered,
    setHovered,
  ] = useState<string | null>(null)
  const [
    focused,
    setFocused,
  ] = useState<string | null>(null)
  const emphasis = `${highlight}-emphasis`
  const emphasized = useRef<{
    id: string | null
    cards: HTMLElement[]
  }>({
    id: null,
    cards: [],
  })
  const [
    jump,
    setJump,
  ] = useState<{
    id: string
    key: number
  } | null>(null)

  useLayoutEffect(
    () => {
      const root = host.current
      const comment = comments.find(item => item.id === (hovered ?? focused ?? jump?.id))

      if (!root || !HIGHLIGHT_SUPPORTED) {
        return
      }

      if (emphasized.current.id !== (comment?.id ?? null)) {
        fadeHighlight({
          name: emphasis,
          scope: highlight,
          emphasis: true,
        })
      }

      for (const card of emphasized.current.cards) {
        delete card.dataset.emphasis
      }

      const cards = comment ? [...document.querySelectorAll<HTMLElement>('[data-comment-ref]')]
        .filter(card => card.dataset.commentRef === comment.id) : []

      for (const card of cards) {
        card.dataset.emphasis = ''
      }

      emphasized.current = {
        id: comment?.id ?? null,
        cards,
      }
      const ranges = comment ? commentRanges({
        host: root,
        comment,
      }) : []

      if (ranges.length) {
        const painting = new Highlight(...ranges)
        painting.priority = 1
        CSS.highlights.set(
          emphasis,
          painting,
        )
      } else {
        CSS.highlights.delete(emphasis)
      }
    },
    [
      host,
      comments,
      hovered,
      focused,
      jump,
      emphasis,
    ],
  )

  useEffect(
    () => () => {
      for (const card of emphasized.current.cards) {
        delete card.dataset.emphasis
      }
    },
    [],
  )

  useLayoutEffect(
    () => {
      const card = jump && host.current?.querySelector<HTMLElement>(`[data-comment-id="${CSS.escape(jump.id)}"]`)

      if (!card) {
        return
      }

      // Flush the cleared state so a second jump restarts the single pulse.
      void card.offsetWidth
      card.style.setProperty(
        '--comment-jump-duration',
        `${JUMP_DURATION}ms`,
      )
      card.dataset.jump = ''

      return () => {
        delete card.dataset.jump
        card.style.removeProperty('--comment-jump-duration')
      }
    },
    [
      host,
      jump,
    ],
  )

  useEffect(
    () => {
      if (!jump) {
        return
      }

      const timer = setTimeout(
        () => setJump(null),
        JUMP_DURATION,
      )

      return () => clearTimeout(timer)
    },
    [jump],
  )

  useLayoutEffect(
    () => {
      const root = host.current

      if (!root) {
        return
      }

      let frame = 0

      const update = () => {
        frame = 0
        const box = root.getBoundingClientRect()
        const anchors = []
        const rects: Rect[] = []

        for (const [
          index,
          comment,
        ] of comments.entries()) {
          const ranges = commentRanges({
            host: root,
            comment,
          })
          const fragments = ranges.flatMap(range => [...range.getClientRects()])
            .filter(rect => rect.width && rect.height)
          const last = fragments.at(-1)

          if (!last) {
            continue
          }

          anchors.push({
            key: comment.id,
            number: index + 1,
            top: last.top - box.top - COMMENT_BADGE_SIZE / 2,
            left: last.right - box.left,
          })

          if (comment.id === jump?.id) {
            rects.push(...fragments.map(rect => ({
              top: rect.top - box.top,
              left: rect.left - box.left,
              width: rect.width,
              height: rect.height,
            })))
          }
        }

        const next = {
          piles: commentPiles({ anchors }),
          rects,
          width: box.width,
        }
        setLayout(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next)
      }

      const schedule = () => {
        if (!frame) {
          frame = requestAnimationFrame(update)
        }
      }

      const reveal = (event: Event) => {
        if (event instanceof CustomEvent && typeof event.detail === 'string') {
          const id = event.detail
          setActive(id)
          setJump(previous => ({
            id,
            key: (previous?.key ?? 0) + 1,
          }))
        }
      }

      const choose = ({ id }: { id: string | null }) => {
        const own = id && comments.some(comment => comment.id === id) ? id : null
        setFocused(own)

        if (own) {
          setActive(own)
        }
      }

      const focus = (event: Event) => {
        const card = event.target instanceof Element
          ? event.target.closest<HTMLElement>('[data-comment-ref]') : null
        choose({ id: card?.dataset.commentRef ?? null })
      }

      const clicked = (event: Event) => {
        if (event instanceof CustomEvent && typeof event.detail === 'string') {
          choose({ id: event.detail })
        }
      }

      const resize = new ResizeObserver(schedule)
      const observer = new MutationObserver(records => {
        if (records.some(record => !layer.current?.contains(record.target))) {
          schedule()
        }
      })
      update()
      resize.observe(root)
      observer.observe(
        root,
        {
          childList: true,
          characterData: true,
          subtree: true,
        },
      )
      document.addEventListener(
        'scroll',
        schedule,
        true,
      )
      root.addEventListener(
        COMMENT_REVEAL,
        reveal,
      )
      document.addEventListener(
        'focusin',
        focus,
      )
      document.addEventListener(
        COMMENT_FOCUS,
        clicked,
      )
      document.addEventListener(
        'pointerdown',
        focus,
      )

      return () => {
        cancelAnimationFrame(frame)
        resize.disconnect(); observer.disconnect()
        document.removeEventListener(
          'scroll',
          schedule,
          true,
        )
        root.removeEventListener(
          COMMENT_REVEAL,
          reveal,
        )
        document.removeEventListener(
          'focusin',
          focus,
        )
        document.removeEventListener(
          COMMENT_FOCUS,
          clicked,
        )
        document.removeEventListener(
          'pointerdown',
          focus,
        )
      }
    },
    [
      comments,
      host,
      jump,
    ],
  )

  return (
    <div className="comment-annotations" ref={layer} contentEditable={false}>
      <style>{`::highlight(${emphasis}) { background-color: var(--comment-emphasis); text-decoration: underline; text-decoration-color: var(--color-gold); }`}</style>
      {jump && layout.rects.map((
        rect,
        index,
      ) => (
        <span
          key={`${jump.key}-${index}`}
          className="comment-jump"
          style={{
            ...rect,
            animationDuration: `${JUMP_DURATION}ms`,
          }}
          aria-hidden="true"
        />
      ))}
      {layout.piles.map(pile => (
        <CommentPile
          key={pile.key}
          pile={pile}
          width={layout.width}
          active={hovered ?? active}
          hover={({ id }) => setHovered(id)}
          show={({ id }) => {
            const root = host.current, comment = comments.find(item => item.id === id)

            if (root && comment) {
              revealComment({
                host: root,
                comment,
              })
            }
          }}
        />
      ))}
    </div>
  )
}

import { useEffect, useRef, type RefObject } from 'react'
import { flushSync } from 'react-dom'

const START_DISTANCE = 6
const SETTLE_MS = 180
const EDGE_MARGIN = 48
const SCROLL_STEP = 16
export interface PhysicalMove {
  id: string
  over: string
  kind: string
  scope: string
  targetScope: string
  hydra: string
  before: boolean
  nest: boolean
  detach?: boolean
}

export function movedOrder<T>({
  items,
  id,
  over,
  before,
  key,
}: {
  items: T[]
  id: string
  over: string
  before: boolean
  key({ item }: { item: T }): string
}): T[] {
  const item = items.find(item => key({ item }) === id)

  if (!item || id === over) {
    return items
  }

  const remaining = items.filter(item => key({ item }) !== id)
  const at = remaining.findIndex(item => key({ item }) === over)

  if (at < 0) {
    return items
  }

  remaining.splice(
    at + (before ? 0 : 1),
    0,
    item,
  )

  return remaining
}

export function usePhysicalDrag({
  root,
  move,
  drop,
}: {
  root: RefObject<HTMLElement | null>
  move({ preview }: { preview: PhysicalMove | null }): void
  drop({ preview }: { preview: PhysicalMove }): void
}) {
  const callbacks = useRef({
    move,
    drop,
  })
  callbacks.current = {
    move,
    drop,
  }
  useEffect(
    () => {
      const surface = root.current

      if (!surface) {
        return
      }

      let source: HTMLElement | null = null
      let ghost: HTMLElement | null = null
      let x = 0, y = 0
      let origin: DOMRect | undefined
      let latest: PhysicalMove | null = null
      let frame = 0, scrollFrame = 0
      let pointerX = 0, pointerY = 0
      let suppressClick = false
      let suppressTimer: ReturnType<typeof setTimeout> | undefined

      const clicked = (event: MouseEvent) => {
        if (!suppressClick) {
          return
        }

        event.preventDefault(); event.stopPropagation(); suppressClick = false
      }

      const autoScroll = () => {
        if (!ghost) {
          return
        }

        const oldX = surface.scrollLeft

        if (pointerX < EDGE_MARGIN) {
          surface.scrollLeft -= SCROLL_STEP
        } else if (pointerX > innerWidth - EDGE_MARGIN) {
          surface.scrollLeft += SCROLL_STEP
        }

        const column = document.elementFromPoint(
          pointerX,
          pointerY,
        )?.closest<HTMLElement>('.column-cards')
        const oldY = column?.scrollTop

        if (column) {
          const rect = column.getBoundingClientRect()

          if (pointerY < rect.top + EDGE_MARGIN) {
            column.scrollTop -= SCROLL_STEP
          } else if (pointerY > rect.bottom - EDGE_MARGIN) {
            column.scrollTop += SCROLL_STEP
          }
        }

        if (oldX !== surface.scrollLeft || oldY !== column?.scrollTop) {
          pointer(new PointerEvent(
            'pointermove',
            {
              clientX: pointerX,
              clientY: pointerY,
            },
          ))
        }

        scrollFrame = requestAnimationFrame(autoScroll)
      }

      const cleanup = () => {
        ghost?.remove(); ghost = null
        source?.removeAttribute('data-lifted'); source = null
        surface.removeAttribute('data-dragging'); surface.removeAttribute('data-drag-parent')
        cancelAnimationFrame(frame)
        cancelAnimationFrame(scrollFrame)
        callbacks.current.move({ preview: null })
      }

      const down = (event: PointerEvent) => {
        if (event.button !== 0 || !(event.target instanceof Element)) {
          return
        }

        const control = event.target.closest('button,input,textarea,select,a,.resize,[contenteditable=true]')

        if (control && !control.matches('[data-sort-id],[data-column-heading]')) {
          return
        }

        const candidate = event.target.closest<HTMLElement>('[data-sort-id]')

        if (!candidate || candidate.dataset.sortDisabled === 'true') {
          return
        }

        const header = event.target.closest('.project-column-heading,.project-chips')

        if (candidate.dataset.sortKind === 'project' && !header) {
          return
        }

        source = candidate
        x = event.clientX; y = event.clientY
        origin = source.getBoundingClientRect()
        latest = null
      }

      // eslint-disable-next-line pnyx/object-params -- PointerEvent listener, also replayed during edge scrolling.
      const pointer = (event: PointerEvent) => {
        pointerX = event.clientX; pointerY = event.clientY

        if (!source || !origin) {
          return
        }

        if (!ghost && Math.hypot(
          event.clientX - x,
          event.clientY - y,
        ) < START_DISTANCE) {
          return
        }

        event.preventDefault()

        if (!ghost) {
          ghost = source.cloneNode(true) as HTMLElement
          ghost.classList.add('physical-ghost')
          ghost.removeAttribute('id'); ghost.querySelectorAll('[id]').forEach(element => element.removeAttribute('id'))
          ghost.inert = true; ghost.setAttribute(
            'aria-hidden',
            'true',
          )
          Object.assign(
            ghost.style,
            {
              width: `${origin.width}px`,
              height: `${Math.min(
                origin.height,
                130,
              )}px`,
              left: `${origin.left}px`,
              top: `${origin.top}px`,
            },
          )
          document.body.append(ghost)
          source.dataset.lifted = 'true'
          surface.dataset.dragging = source.dataset.sortKind

          if (source.dataset.hasChildren === 'true') {
            surface.dataset.dragParent = 'true'
          }

          scrollFrame = requestAnimationFrame(autoScroll)
        }

        ghost.style.transform = `translate3d(${event.clientX - x}px, ${event.clientY - y}px, 0) scale(1.02)`
        const hit = document.elementFromPoint(
          event.clientX,
          event.clientY,
        )
        const target = hit?.closest<HTMLElement>('[data-sort-id]')

        const project = hit?.closest<HTMLElement>('.project-column')
        const hydra = source.closest<HTMLElement>('[data-hydra-workspace]')?.dataset.hydraWorkspace ?? ''

        if (source.dataset.parent && project && !hit?.closest('.card')
          && project.closest<HTMLElement>('[data-hydra-workspace]')?.dataset.hydraWorkspace === hydra) {
          latest = {
            id: source.dataset.sortId!,
            over: '',
            kind: 'task',
            scope: source.dataset.sortScope!,
            targetScope: '',
            hydra,
            before: false,
            nest: false,
            detach: true,
          }
          callbacks.current.move({ preview: latest })

          return
        }

        if (target === source) {
          latest = null
          callbacks.current.move({ preview: null })
          return
        }

        if (!target || target.dataset.sortKind !== source.dataset.sortKind) {
          latest = null
          callbacks.current.move({ preview: null })

          return
        }

        const sourceHydra = source.closest<HTMLElement>('[data-hydra-workspace]')?.dataset.hydraWorkspace
        const targetHydra = target.closest<HTMLElement>('[data-hydra-workspace]')?.dataset.hydraWorkspace

        if (source.dataset.sortKind !== 'hydra' && sourceHydra !== targetHydra) {
          latest = null; callbacks.current.move({ preview: null })

          return
        }

        if (source.dataset.sortKind === 'project' && target.dataset.sortDisabled === 'true') {
          latest = null
          callbacks.current.move({ preview: null })
          return
        }

        const rect = target.getBoundingClientRect()
        const horizontal = source.dataset.sortKind !== 'task'
        const sourceRect = source.getBoundingClientRect()
        const sameRow = Math.abs(sourceRect.top - rect.top) < rect.height / 2
        const across = horizontal || sameRow
        const before = across ? event.clientX < rect.left + rect.width / 2
          : event.clientY < rect.top + rect.height / 2
        const nest = !!hit?.closest('[data-subtask-drop]') && source.dataset.hasChildren !== 'true'
        const preview: PhysicalMove = {
          id: source.dataset.sortId!,
          over: target.dataset.sortId!,
          kind: source.dataset.sortKind!,
          scope: source.dataset.sortScope!,
          targetScope: target.dataset.sortScope!,
          hydra: source.closest<HTMLElement>('[data-hydra-workspace]')?.dataset.hydraWorkspace ?? '',
          before,
          nest,
        }

        if (JSON.stringify(preview) === JSON.stringify(latest)) {
          return
        }

        latest = preview
        const selector = source.dataset.sortKind === 'hydra' ? '.hydra-workspace,.hydra-chip'
          : `[data-sort-kind="${source.dataset.sortKind}"]`
        const siblings = [...surface.querySelectorAll<HTMLElement>(selector)]
        const previous = new Map(siblings.map(element => [
          element,
          element.getBoundingClientRect(),
        ]))
        flushSync(() => callbacks.current.move({ preview }))
        cancelAnimationFrame(frame)
        frame = requestAnimationFrame(() => {
          if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
            return
          }

          for (const element of siblings) {
            if (element === source || !element.isConnected) {
              continue
            }

            const old = previous.get(element)!, now = element.getBoundingClientRect()
            const dx = old.left - now.left, dy = old.top - now.top

            if (Math.abs(dx) + Math.abs(dy) > 1) {
              element.animate(
                [
                  { transform: `translate(${dx}px, ${dy}px)` },
                  { transform: 'none' },
                ],
                {
                  duration: SETTLE_MS,
                  easing: 'cubic-bezier(.2,.8,.2,1)',
                },
              )
            }
          }
        })
      }

      const up = () => {
        suppressClick = !!ghost
        clearTimeout(suppressTimer)
        suppressTimer = setTimeout(
          () => {
            suppressClick = false
          },
          0,
        )
        const result = ghost ? latest : null
        cleanup()

        if (result) {
          callbacks.current.drop({ preview: result })
        }
      }

      const cancel = () => cleanup()

      const key = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
          cleanup()
        }
      }

      surface.addEventListener(
        'click',
        clicked,
        true,
      )
      surface.addEventListener(
        'pointerdown',
        down,
      )
      window.addEventListener(
        'pointermove',
        pointer,
        { passive: false },
      )
      window.addEventListener(
        'pointerup',
        up,
      )
      window.addEventListener(
        'pointercancel',
        cancel,
      )
      window.addEventListener(
        'keydown',
        key,
      )

      return () => {
        cleanup()
        clearTimeout(suppressTimer)
        surface.removeEventListener(
          'click',
          clicked,
          true,
        )
        surface.removeEventListener(
          'pointerdown',
          down,
        )
        window.removeEventListener(
          'pointermove',
          pointer,
        )
        window.removeEventListener(
          'pointerup',
          up,
        )
        window.removeEventListener(
          'pointercancel',
          cancel,
        )
        window.removeEventListener(
          'keydown',
          key,
        )
      }
    },
    [root],
  )
}

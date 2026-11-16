import { useEffect, useRef, type RefObject } from 'react'
import { flushSync } from 'react-dom'
import { HOVER_CLAIM } from './tooltip.tsx'

const START_DISTANCE = 6
const SETTLE_MS = 200
const DROP_MS = 220
const MOVE_AGAIN_PX = 10
const DRAG_EASING = 'cubic-bezier(.22,1,.36,1)'
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

function layoutBounds({ element }: { element: HTMLElement }) {
  const rect = element.getBoundingClientRect()
  let dx = 0, dy = 0

  for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) {
    const transform = new DOMMatrixReadOnly(getComputedStyle(parent).transform)
    dx += transform.m41
    dy += transform.m42
  }

  return new DOMRect(
    rect.left - dx,
    rect.top - dy,
    rect.width,
    rect.height,
  )
}

function distanceToPoint({
  rect,
  x,
  y,
}: {
  rect: DOMRect
  x: number
  y: number
}) {
  const dx = Math.max(
    rect.left - x,
    0,
    x - rect.right,
  )
  const dy = Math.max(
    rect.top - y,
    0,
    y - rect.bottom,
  )

  return Math.hypot(
    dx,
    dy,
  )
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
      let lifted: HTMLElement | null = null
      let slot: HTMLElement | null = null
      let hovered: HTMLElement | null = null
      let settling = false
      let movedAt: {
        x: number
        y: number
      } | null = null
      let x = 0, y = 0
      let origin: DOMRect | undefined
      let latest: PhysicalMove | null = null
      let placement: PhysicalMove | null = null
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
        ghost?.remove(); ghost = null; lifted = null
        slot?.removeAttribute('data-drag-slot'); slot = null
        hovered?.removeAttribute('data-drag-hover'); hovered?.removeAttribute('data-nest-armed'); hovered = null
        surface.querySelectorAll('[data-drag-excluded]').forEach(element => element.removeAttribute('data-drag-excluded'))
        source?.removeAttribute('data-lifted'); source = null
        settling = false; movedAt = null; latest = null; placement = null
        surface.removeAttribute('data-dragging'); surface.removeAttribute('data-drag-parent')
        cancelAnimationFrame(frame)
        cancelAnimationFrame(scrollFrame)
        callbacks.current.move({ preview: null })
      }

      const down = (event: PointerEvent) => {
        if (settling || event.button !== 0 || !(event.target instanceof Element)) {
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
        slot = source.dataset.sortKind === 'task'
          ? source.closest<HTMLElement>('[data-child],.task-family') ?? source : source
        origin = slot.getBoundingClientRect()
        latest = null; movedAt = null
      }

      // eslint-disable-next-line pnyx/object-params -- PointerEvent listener, also replayed during edge scrolling.
      const pointer = (event: PointerEvent) => {
        pointerX = event.clientX; pointerY = event.clientY

        if (settling || !source || !origin || !slot) {
          return
        }

        const sourceScope = source.dataset.sortScope

        if (!ghost && Math.hypot(
          event.clientX - x,
          event.clientY - y,
        ) < START_DISTANCE) {
          return
        }

        event.preventDefault()

        if (!ghost) {
          ghost = document.createElement('div')
          ghost.className = 'physical-ghost project-cards'
          lifted = slot.cloneNode(true) as HTMLElement
          lifted.removeAttribute('id')
          lifted.querySelectorAll('[id]').forEach(element => element.removeAttribute('id'))
          Object.assign(
            lifted.style,
            {
              position: 'relative',
              left: '0',
              top: '0',
              width: '100%',
              margin: '0',
              transformOrigin: `${x - origin.left}px ${y - origin.top}px`,
            },
          )
          ghost.append(lifted)
          ghost.inert = true
          ghost.setAttribute(
            'aria-hidden',
            'true',
          )
          Object.assign(
            ghost.style,
            {
              left: `${origin.left}px`,
              top: `${origin.top}px`,
              width: `${origin.width}px`,
              height: `${origin.height}px`,
            },
          )
          document.body.append(ghost)

          if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
            lifted.animate(
              [
                { transform: 'none' },
                { transform: 'scale(1.035) rotate(-1deg)' },
              ],
              {
                duration: SETTLE_MS,
                easing: DRAG_EASING,
                fill: 'forwards',
              },
            )
          }

          source.dataset.lifted = 'true'
          slot.dataset.dragSlot = 'true'
          document.dispatchEvent(new CustomEvent(
            HOVER_CLAIM,
            {
              detail: {
                id: 'physical-drag',
                anchor: source,
              },
            },
          ))
          window.getSelection()?.removeAllRanges()
          surface.dataset.dragging = source.dataset.sortKind

          if (source.dataset.sortKind === 'task') {
            surface.querySelectorAll<HTMLElement>('[data-sort-kind=task]').forEach(element => {
              if (element.dataset.sortScope !== sourceScope) {
                element.dataset.dragExcluded = 'true'
              }
            })
          }

          if (source.dataset.hasChildren === 'true') {
            surface.dataset.dragParent = 'true'
          }

          scrollFrame = requestAnimationFrame(autoScroll)
        }

        const dy = source.dataset.sortKind === 'project' ? 0 : event.clientY - y
        ghost.style.transform = `translate3d(${event.clientX - x}px, ${dy}px, 0)`
        const hit = document.elementFromPoint(
          event.clientX,
          event.clientY,
        )
        let target = hit?.closest<HTMLElement>('[data-sort-id]')

        const project = hit?.closest<HTMLElement>('.project-column')
        const hydra = source.closest<HTMLElement>('[data-hydra-workspace]')?.dataset.hydraWorkspace ?? ''

        const sourceHydra = source.closest<HTMLElement>('[data-hydra-workspace]')?.dataset.hydraWorkspace
        const targetHydra = target?.closest<HTMLElement>('[data-hydra-workspace]')?.dataset.hydraWorkspace

        const hover = source.dataset.sortKind === 'task' && target?.dataset.sortKind === 'task'
          && sourceHydra === targetHydra && target !== source && !target.dataset.parent
          && target.dataset.sortId !== source.dataset.parent ? target : null

        if (hover !== hovered) {
          hovered?.removeAttribute('data-drag-hover')
          hovered?.removeAttribute('data-nest-armed')
          hovered = hover

          if (hovered) {
            hovered.dataset.dragHover = 'true'
          }
        }

        const pill = hovered?.querySelector<HTMLElement>('[data-subtask-drop]')
        const pillRect = pill?.getBoundingClientRect()
        const nest = !!pillRect?.width && source.dataset.hasChildren !== 'true'
          && distanceToPoint({
            rect: pillRect,
            x: event.clientX,
            y: event.clientY,
          }) === 0

        if (hovered) {
          hovered.toggleAttribute(
            'data-nest-armed',
            nest,
          )
        }

        if (lifted) {
          const tucked = lifted.dataset.tucked === 'true'

          if (tucked !== nest) {
            const before = getComputedStyle(lifted).transform
            lifted.getAnimations().forEach(animation => animation.cancel())
            lifted.dataset.tucked = String(nest)
            lifted.animate(
              [
                { transform: before },
                { transform: nest ? 'scale(.5)' : 'scale(1.035) rotate(-1deg)' },
              ],
              {
                duration: SETTLE_MS,
                easing: DRAG_EASING,
                fill: 'forwards',
              },
            )
          }
        }

        if (latest?.nest && !nest) {
          latest = placement
          flushSync(() => callbacks.current.move({ preview: placement }))
        }

        if (source.dataset.sortKind !== 'hydra' && sourceHydra !== targetHydra) {
          return
        }

        const parent = source.dataset.parent ? source.closest<HTMLElement>('.task-family') : null
        const outsideParent = parent && distanceToPoint({
          rect: layoutBounds({ element: parent }),
          x: event.clientX,
          y: event.clientY,
        }) > 0

        if (outsideParent && project && !nest
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

        if (source.dataset.sortKind === 'task' && !nest) {
          const home = source.closest('.project-column')

          if (project !== home && !source.dataset.parent) {
            return
          }

          const slotRect = layoutBounds({ element: slot })

          if (distanceToPoint({
            rect: slotRect,
            x: event.clientX,
            y: event.clientY,
          }) === 0) {
            return
          }

          const candidates = [...surface.querySelectorAll<HTMLElement>('[data-sort-kind=task]')]
            .filter(element => element !== source
              && element.dataset.sortScope === sourceScope)
          const targets = candidates.map(element => ({
            element,
            distance: distanceToPoint({
              rect: layoutBounds({ element }),
              x: event.clientX,
              y: event.clientY,
            }),
          }))
          target = targets.sort((
            a,
            b,
          ) => a.distance - b.distance)[0]?.element
        }

        if (!target || target === source || target.dataset.sortKind !== source.dataset.sortKind) {
          return
        }

        if (source.dataset.sortKind === 'project' && target.dataset.sortDisabled === 'true') {
          latest = null
          callbacks.current.move({ preview: null })

          return
        }

        const grouped = target.dataset.hasChildren === 'true'
        const targetBox = grouped ? target.closest<HTMLElement>('.task-family') ?? target : target
        const rect = layoutBounds({ element: targetBox })
        let before = event.clientX < rect.left + rect.width / 2

        if (source.dataset.sortKind === 'task') {
          before = grouped ? event.clientY < rect.top + rect.height / 2
            : event.clientY < rect.top || (event.clientY <= rect.bottom
              && event.clientX < rect.left + rect.width / 2)
        }

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

        if (!nest && movedAt && Math.hypot(
          event.clientX - movedAt.x,
          event.clientY - movedAt.y,
        ) < MOVE_AGAIN_PX) {
          return
        }

        movedAt = {
          x: event.clientX,
          y: event.clientY,
        }
        latest = preview

        if (!nest) {
          placement = preview
        }

        let selector = `[data-sort-kind="${source.dataset.sortKind}"]`

        if (source.dataset.sortKind === 'hydra') {
          selector = '.hydra-workspace,.hydra-chip'
        }

        if (source.dataset.sortKind === 'task') {
          selector = source.dataset.parent ? '[data-child]' : '.task-family'
        }

        const sortingHydras = source.dataset.sortKind === 'hydra'
        const siblings = [...surface.querySelectorAll<HTMLElement>(selector)].filter(element =>
          sortingHydras
          || element.closest<HTMLElement>('[data-hydra-workspace]')?.dataset.hydraWorkspace === hydra)
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
            if (element === slot || !element.isConnected) {
              continue
            }

            const old = previous.get(element)!, now = layoutBounds({ element })
            element.getAnimations().forEach(animation => animation.cancel())
            const dx = old.left - now.left, dy = old.top - now.top

            if (Math.abs(dx) + Math.abs(dy) > 1) {
              element.animate(
                [
                  { transform: `translate(${dx}px, ${dy}px)` },
                  { transform: 'none' },
                ],
                {
                  duration: SETTLE_MS,
                  easing: DRAG_EASING,
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

        if (!ghost || !slot || !origin || matchMedia('(prefers-reduced-motion: reduce)').matches) {
          cleanup()

          if (result) {
            callbacks.current.drop({ preview: result })
          }

          return
        }

        settling = true
        cancelAnimationFrame(scrollFrame)
        const target = result?.nest
          ? surface.querySelector<HTMLElement>(`[data-sort-kind=task][data-sort-id="${CSS.escape(result.over)}"]`) : slot
        const landing = (target ?? slot).getBoundingClientRect()
        const moving = ghost
        const translate = `translate(${landing.left - origin.left}px, ${landing.top - origin.top}px)`
        const ending = result?.nest ? {
          transform: `${translate} scale(.35)`,
          opacity: 0,
        }
          : {
            transform: translate,
            opacity: 1,
          }
        const animation = ghost.animate(
          [
            {
              transform: ghost.style.transform,
              opacity: 1,
            },
            ending,
          ],
          {
            duration: DROP_MS,
            easing: DRAG_EASING,
            fill: 'forwards',
          },
        )

        animation.onfinish = () => {
          if (ghost === moving) {
            cleanup()
          }
        }

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

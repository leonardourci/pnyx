import { openTaskFamily } from '#web-tasks/task-view.ts'
import { WorkspaceViewport } from './workspace-viewport.tsx'
import { useMotionDuration, MOTION_EASING } from '#web-shared/motion.ts'
import { StatusNotice } from '#web-shared/ui/status-message.tsx'
import { IconButton } from '#web-shared/ui/icon-button.tsx'
import { memo, startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps } from 'react'
import { SortableWorkspace, SortGroup, movedOrder, type SortMove } from '#web-shared/ui/sortable.tsx'
import { motion, MotionConfig } from 'motion/react'
import { useSmoothScroll, scrollBehavior } from '#web-shared/ui/smooth-scroll.ts'
import { afterSteadyLayout } from '#web-tasks/scroll-task.ts'
import { projectColumns, compareTasks, nextSibling } from '#web-tasks/project-view.ts'
import { taskProjectGroup } from '#tasks/order.ts'
import { useTitan } from './connection.ts'
import { useTitanEdits } from './titan-edits.ts'
import { placements } from './titan-order.ts'
import { ProfileSurface } from './profile-surface.tsx'
import { TitanView } from './workspace.tsx'
import { useComposerShortcut } from '#web-titan/composer-shortcut.ts'
import { phoneLayout } from '#web-shared/card-sizing.ts'

const SCROLL_EDGE_EPSILON = 1

const WorkspaceInstance = memo(function WorkspaceInstance({
  titan,
  workspace,
  navigate,
  ...props
}: Omit<ComponentProps<typeof TitanView>, 'titan'> & {
  titan: ReturnType<typeof useTitan>
  workspace: ReturnType<typeof useTitan>['workspaces'][number]
  navigate: ReturnType<typeof useTitan>['navigate']
}) {
  return (
    <TitanView
      {...props}
      titan={{
        ...titan,
        ...workspace,
        navigate,
        command: titan.commandFor({id: workspace.navigation.titanId}),
      }}
    />
  )
})

export function App() {
  const duration = useMotionDuration()
  const titan = useTitan()

  const current = titan.navigation.titanId
  useComposerShortcut({ titanId: current })
  const axis = useRef<HTMLDivElement>(null)
  const track = useRef<HTMLDivElement>(null)
  const anchor = useRef<() => void>(undefined)
  const alignment = useRef<AbortController | null>(null)
  const ownerAxisScroll = useRef(false)
  useEffect(
    () => () => alignment.current?.abort(),
    [],
  )
  const smoothScroll = useSmoothScroll({
    root: axis,
    content: track,
    horizontal: true,
    snapKey: titan.navigation.titans.map(item => item.id).join(':'),
  })
  const [
    preview,
    setPreview,
  ] = useState<SortMove | null>(null)
  const [
    rootError,
    setRootError,
  ] = useState('')
  const rootNotify = useCallback(
    ({ text }: { text: string }) => setRootError(text),
    [],
  )
  const edits = useTitanEdits({
    titans: titan.navigation.titans,
    command: titan.command,
    notify: rootNotify,
  })
  const orderedTitans = preview?.kind === 'titan' ? movedOrder({
    items: edits.titans,
    ...preview,
    key: ({ item }) => item.id,
  }) : edits.titans
  const shownEdits = useMemo(
    () => ({
      ...edits,
      titans: orderedTitans,
    }),
    [
      edits,
      orderedTitans,
    ],
  )
  const workspaces = [...titan.workspaces].sort((
    a,
    b,
  ) =>
    orderedTitans.findIndex(item => item.id === a.navigation.titanId)
    - orderedTitans.findIndex(item => item.id === b.navigation.titanId))

  const drop = ({ preview }: { preview: SortMove }) => {
    const commit = async () => {
      if (preview.kind === 'titan') {
        const index = movedOrder({
          items: edits.titans,
          ...preview,
          key: ({ item }) => item.id,
        }).findIndex(item => item.id === preview.id)

        for (const placement of placements({
          titans: edits.titans,
          id: preview.id,
          index,
        })) {
          await edits.move(placement)
        }

        return
      }

      const workspace = titan.workspaces.find(item => item.navigation.titanId === preview.titan)

      if (!workspace) {
        return
      }

      const command = titan.commandFor({ id: preview.titan })
      const event = crypto.randomUUID()

      if (preview.kind === 'project') {
        const columns = projectColumns({
          state: workspace.state,
          cards: Object.values(workspace.state.cards),
          actions: workspace.actions,
          order: workspace.state.view?.workspace?.projectOrder ?? [],
        })
        const ordered = movedOrder({
          items: columns,
          ...preview,
          key: ({ item }) => item.id,
        })
        await command({
          name: 'view',
          args: [
            'set',
            '--json',
            JSON.stringify({ workspace: { projectOrder: ordered.map(item => item.id) } }),
            '--event-id',
            event,
          ],
        })

        return
      }

      const card = workspace.state.cards[preview.id], target = workspace.state.cards[preview.over]

      if (card && preview.outdent) {
        const roots = projectColumns({
          state: workspace.state,
          cards: Object.values(workspace.state.cards),
          actions: workspace.actions,
          order: [],
        }).find(column => column.id === preview.targetScope)?.cards ?? []
        const anchor = roots.findIndex(item => item.id === preview.over)
        const placed = anchor < 0 ? [
          ...roots,
          card,
        ] : roots.toSpliced(
          anchor + (preview.before ? 0 : 1),
          0,
          card,
        )
        const next = nextSibling({
          state: workspace.state,
          actions: workspace.actions,
          card,
          cards: placed,
        })
        const args = [
          'parent',
          card.id,
          'none',
          '--event-id',
          event,
        ]

        if (next) {
          args.push(
            '--before',
            next.id,
          )
        }

        await command({
          name: 'task',
          args,
        })

        return
      }

      if (!card || !target) {
        return
      }

      if (preview.nest) {
        openTaskFamily({
          titanId: preview.titan,
          id: target.id,
        })
        await command({
          name: 'task',
          args: [
            'parent',
            card.id,
            target.id,
            '--event-id',
            event,
          ],
        })

        return
      }

      if (preview.scope !== preview.targetScope) {
        return
      }

      const columns = projectColumns({
        state: workspace.state,
        cards: Object.values(workspace.state.cards),
        actions: workspace.actions,
        order: [],
      })
      const childCards = Object.values(workspace.state.cards).filter(item =>
        item.parentId === card.parentId)
        .sort(compareTasks({
          state: workspace.state,
          actions: workspace.actions,
        }))
      const siblings = card.parentId ? childCards
        : columns.find(column => column.id === taskProjectGroup({
          state: workspace.state,
          card,
        }))?.cards ?? []
      const ordered = movedOrder({
        items: siblings,
        ...preview,
        key: ({ item }) => item.id,
      })
      const next = nextSibling({
        state: workspace.state,
        actions: workspace.actions,
        card,
        cards: ordered,
      })
      const args = [
        'arrange',
        card.id,
        '--event-id',
        event,
      ]

      if (next) {
        args.push(
          '--before',
          next.id,
        )
      }

      await command({
        name: 'task',
        args,
      })
    }

    commit().catch((error: Error) => setRootError(error.message))
  }

  const visibleWorkspaceIds = workspaces.map(workspace => workspace.navigation.titanId)
  const workspaceOrder = visibleWorkspaceIds.join(':')

  useLayoutEffect(
    () => {
      const surface = axis.current
      const inner = track.current
      const group = surface?.querySelector<HTMLElement>(`[data-titan-workspace="${CSS.escape(current)}"]`)

      if (!titan.loaded || !surface || !inner || !group) {
        return
      }

      let previous: {
        left: number
        range: number
        available: number
        scroll: number
      } | undefined
      let clamped = false

      const position = () => {
        const padding = parseFloat(getComputedStyle(surface).scrollPaddingLeft) || 0
        const left = group.offsetLeft + inner.offsetLeft - surface.offsetLeft - padding

        const range = Math.max(
          0,
          group.offsetWidth - surface.clientWidth,
        )

        return {
          left,
          range,
          available: surface.scrollWidth - surface.clientWidth,
        }
      }

      const rememberScroll = () => {
        if (!previous) {
          return
        }

        const {
          left,
          available,
        } = position()

        if (left === previous.left && available === previous.available) {
          previous.scroll = surface.scrollLeft
        }
      }

      const align = () => {
        const {
          left,
          range,
          available,
        } = position()
        group.dataset.axisOffset = String(left)
        group.dataset.axisRange = String(range)
        const actualScroll = surface.scrollLeft
        const last = previous
        // A shrinking track can clamp the browser before its resize observer runs.
        const trackShrank = last && available < last.available
        const atScrollEnd = Math.abs(actualScroll - available) < SCROLL_EDGE_EPSILON
        const scroll = trackShrank && atScrollEnd && last.scroll > available
          ? last.scroll : actualScroll
        const restore = clamped && available >= left
        const shift = previous === undefined || restore
          ? left - scroll : left - previous.left
        clamped = available < left

        const shrinking = previous !== undefined && range < previous.range

        const desired = scroll + shift
        const destination = shrinking ? Math.min(
          desired,
          left + range,
        ) : desired

        if (destination !== actualScroll || shrinking) {
          if (smoothScroll.current) {
            smoothScroll.current.resize()
            smoothScroll.current.scrollTo(
              destination,
              {
                immediate: true,
                force: true,
              },
            )
          } else {
            surface.scrollTo({
              left: destination,
              behavior: 'instant',
            })
          }
        }

        previous = {
          left,
          range,
          available,
          scroll: surface.scrollLeft,
        }
      }

      surface.addEventListener(
        'scroll',
        rememberScroll,
        { passive: true },
      )
      align()
      anchor.current = align
      const observer = new ResizeObserver(align)
      observer.observe(inner)
      observer.observe(surface)
      surface.querySelectorAll('[data-titan-workspace]').forEach(workspace => observer.observe(workspace))

      return () => {
        surface.removeEventListener(
          'scroll',
          rememberScroll,
        )
        anchor.current = undefined
        observer.disconnect()
      }
    },
    [
      current,
      titan.loaded,
      workspaceOrder,
      smoothScroll,
    ],
  )

  useEffect(
    () => {
      const surface = axis.current

      if (!surface) {
        return
      }

      ownerAxisScroll.current = false

      const follow = () => {
        if (phoneLayout({ width: innerWidth }) || !ownerAxisScroll.current || !titan.loaded || surface.dataset.dragging || titan.navigation.page === 'settings') {
          return
        }

        const padding = parseFloat(getComputedStyle(surface).scrollPaddingLeft) || 0
        const left = surface.getBoundingClientRect().left + padding
        const destination = [...surface.querySelectorAll<HTMLElement>('[data-titan-workspace]')]
          .find(element => Math.abs(element.getBoundingClientRect().left - left) < 2)
          ?.dataset.titanWorkspace

        if (destination) {
          ownerAxisScroll.current = false
        }

        if (destination && destination !== current) {
          titan.navigate({ url: `/titan/${encodeURIComponent(destination)}/` })
            .catch((error: Error) => setRootError(error.message))
        }
      }

      let pressed: {
        x: number
        y: number
      } | null = null

      const wheel = (event: WheelEvent) => {
        if (Math.abs(event.deltaX) > Math.abs(event.deltaY) || event.shiftKey) {
          ownerAxisScroll.current = true
        }
      }

      const down = (event: PointerEvent) => {
        pressed = {
          x: event.clientX,
          y: event.clientY,
        }

        if (event.target === surface) {
          ownerAxisScroll.current = true
        }
      }

      const move = (event: PointerEvent) => {
        if (pressed && !surface.dataset.dragging
          && Math.abs(event.clientX - pressed.x) > Math.abs(event.clientY - pressed.y)) {
          ownerAxisScroll.current = true
        }
      }

      const up = () => {
        pressed = null
      }

      const controller = new AbortController()
      const options = {
        passive: true,
        signal: controller.signal,
      }
      surface.addEventListener(
        'wheel',
        wheel,
        options,
      )
      surface.addEventListener(
        'pointerdown',
        down,
        options,
      )
      surface.addEventListener(
        'pointermove',
        move,
        options,
      )
      addEventListener(
        'pointerup',
        up,
        options,
      )
      addEventListener(
        'pointercancel',
        up,
        options,
      )

      surface.addEventListener(
        'scrollend',
        follow,
      )

      return () => {
        controller.abort()
        surface.removeEventListener(
          'scrollend',
          follow,
        )
      }
    },
    [
      current,
      titan.navigate,
      titan.navigation.page,
      titan.loaded,
    ],
  )

  const navigate = useCallback(
    async ({
      url,
      replace,
    }: {
      url: string
      replace?: boolean
    }) => {
      const destination = decodeURIComponent(new URL(
        url,
        location.href,
      ).pathname.split('/')[2]!)
      if (!phoneLayout({ width: innerWidth })) {
        titan.commandFor({ id: destination })({
          name: 'view',
          args: [
            'set',
            '--json',
            JSON.stringify({
              workspace: {
                collapsed: false,
                chatCollapsed: false,
              },
            }),
            '--event-id',
            crypto.randomUUID(),
          ],
        }).catch((error: Error) => setRootError(error.message))
      }
      await titan.navigate({
        url,
        replace,
      })
      const group = document.querySelector<HTMLElement>(`[data-titan-workspace="${CSS.escape(destination)}"]`)
      group?.scrollIntoView({
        behavior: scrollBehavior(),
        inline: 'start',
        block: 'nearest',
      })
      group?.querySelector<HTMLElement>('.titan-chat .composer-text')?.focus({ preventScroll: true })
      alignment.current?.abort()
      const controller = new AbortController()
      alignment.current = controller

      if (group && await afterSteadyLayout({
        element: group,
        signal: controller.signal,
      })) {
        group.scrollIntoView({
          behavior: scrollBehavior(),
          inline: 'start',
          block: 'nearest',
        })
      }
    },
    [
      titan.commandFor,
      titan.navigate,
    ],
  )

  return (
    <MotionConfig
      reducedMotion={duration === 0 ? 'always' : 'user'}
      skipAnimations={duration === 0}
      transition={{
        duration: duration / 1000,
        ease: MOTION_EASING,
      }}
    >
      <ProfileSurface name="sortable">
        <SortableWorkspace
          root={axis}
          move={({ preview }) => startTransition(() => setPreview(preview))}
          drop={drop}
        >
          <WorkspaceViewport axis={axis}>
            <motion.div
              onBeforeLayoutMeasure={() => anchor.current?.()}
              ref={axis}
              className="workspace-axis group/axis flex h-dvh snap-x snap-proximity scroll-px-3 items-stretch gap-3 overflow-x-auto overflow-y-hidden overscroll-x-contain scroll-smooth px-3 pt-workspace-axis-top pb-3 data-[dragging]:cursor-grabbing data-[page=settings]:overflow-hidden motion-reduce:scroll-auto max-phone:snap-none! max-phone:scroll-px-0 max-phone:gap-0 max-phone:overflow-x-hidden max-phone:px-0 max-phone:pt-topbar-height max-phone:pb-safe-bottom [&.lenis]:snap-none [&.lenis]:scroll-auto [&[data-dragging]_*]:cursor-grabbing! [&[data-dragging]_*]:select-none! [@media(pointer:coarse)]:[&.lenis]:snap-x"
              data-page={titan.navigation.page}
              aria-label="Titans"
            >
              <div ref={track} data-sort-surface="titan-axis" className="workspace-track relative flex h-full w-max items-stretch gap-3 group-data-[page=settings]/axis:invisible">
                {rootError && (
                  <StatusNotice role="alert">{rootError}<IconButton
                    label="Dismiss"
                    onClick={() => setRootError('')}
                    icon="close"
                  />
                  </StatusNotice>
                )}
                <SortGroup id="titan-axis" items={visibleWorkspaceIds}>
                  {workspaces.map(workspace => (
                    <ProfileSurface key={workspace.viewKey} name="workspace" titanId={workspace.navigation.titanId}>
                      <WorkspaceInstance
                        active={workspace.navigation.titanId === current}
                        navigatePage={titan.navigate}
                        navigate={navigate}
                        edits={shownEdits}
                        preview={preview?.titan === workspace.navigation.titanId ? preview : null}
                        titan={titan}
                        workspace={workspace}
                      />
                    </ProfileSurface>
                  ))}
                </SortGroup>
              </div>
            </motion.div>
          </WorkspaceViewport>
        </SortableWorkspace>
      </ProfileSurface>
    </MotionConfig>
  )
}

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
import { useHydra } from './connection.ts'
import { useHydraEdits } from './hydra-edits.ts'
import { useHydraFavicon } from './hydra-favicon.ts'
import { placements } from './hydra-order.ts'
import { ProfileSurface } from './profile-surface.tsx'
import { HydraView } from './workspace.tsx'

const SCROLL_EDGE_EPSILON = 1

const WorkspaceInstance = memo(function WorkspaceInstance({
  hydra,
  workspace,
  navigate,
  ...props
}: Omit<ComponentProps<typeof HydraView>, 'hydra'> & {
  hydra: ReturnType<typeof useHydra>
  workspace: ReturnType<typeof useHydra>['workspaces'][number]
  navigate: ReturnType<typeof useHydra>['navigate']
}) {
  return (
    <HydraView
      {...props}
      hydra={{
        ...hydra,
        ...workspace,
        navigate,
        command: hydra.commandFor({id: workspace.navigation.hydraId}),
      }}
    />
  )
})

export function App() {
  const duration = useMotionDuration()
  const hydra = useHydra()

  const [
    polisFilter,
    filterPolis,
  ] = useState<string | undefined>()
  const current = hydra.navigation.hydraId
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
    snapKey: hydra.navigation.hydras.map(item => item.id).join(':'),
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
  const edits = useHydraEdits({
    hydras: hydra.navigation.hydras,
    command: hydra.command,
    notify: rootNotify,
  })
  const orderedHydras = preview?.kind === 'hydra' ? movedOrder({
    items: edits.hydras,
    ...preview,
    key: ({ item }) => item.id,
  }) : edits.hydras
  const shownEdits = useMemo(
    () => ({
      ...edits,
      hydras: orderedHydras,
    }),
    [
      edits,
      orderedHydras,
    ],
  )
  const workspaces = [...hydra.workspaces].sort((
    a,
    b,
  ) =>
    orderedHydras.findIndex(item => item.id === a.navigation.hydraId)
    - orderedHydras.findIndex(item => item.id === b.navigation.hydraId))

  const currentPolis = orderedHydras.find(item => item.id === current)?.polis ?? 'shared'
  const shownFilter = currentPolis === polisFilter ? polisFilter : undefined
  useEffect(
    () => {
      if (polisFilter && currentPolis !== polisFilter) {
        filterPolis(undefined)
      }
    },
    [
      currentPolis,
      polisFilter,
    ],
  )
  const visibleWorkspaces = workspaces.filter(workspace => !shownFilter
    || (orderedHydras.find(item => item.id === workspace.navigation.hydraId)?.polis ?? 'shared') === shownFilter)

  const drop = ({ preview }: { preview: SortMove }) => {
    const commit = async () => {
      if (preview.kind === 'hydra') {
        const index = movedOrder({
          items: edits.hydras,
          ...preview,
          key: ({ item }) => item.id,
        }).findIndex(item => item.id === preview.id)

        for (const placement of placements({
          hydras: edits.hydras,
          id: preview.id,
          index,
        })) {
          await edits.move(placement)
        }

        return
      }

      const workspace = hydra.workspaces.find(item => item.navigation.hydraId === preview.hydra)

      if (!workspace) {
        return
      }

      const command = hydra.commandFor({ id: preview.hydra })
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
          hydraId: preview.hydra,
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

  const visibleWorkspaceIds = visibleWorkspaces.map(workspace => workspace.navigation.hydraId)
  const workspaceOrder = visibleWorkspaceIds.join(':')

  useLayoutEffect(
    () => {
      const surface = axis.current
      const inner = track.current
      const group = surface?.querySelector<HTMLElement>(`[data-hydra-workspace="${CSS.escape(current)}"]`)

      if (!hydra.loaded || !surface || !inner || !group) {
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
      surface.querySelectorAll('[data-hydra-workspace]').forEach(workspace => observer.observe(workspace))

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
      hydra.loaded,
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
        if (!ownerAxisScroll.current || !hydra.loaded || surface.dataset.dragging || hydra.navigation.page === 'settings') {
          return
        }

        const padding = parseFloat(getComputedStyle(surface).scrollPaddingLeft) || 0
        const left = surface.getBoundingClientRect().left + padding
        const destination = [...surface.querySelectorAll<HTMLElement>('[data-hydra-workspace]')]
          .find(element => Math.abs(element.getBoundingClientRect().left - left) < 2)
          ?.dataset.hydraWorkspace

        if (destination) {
          ownerAxisScroll.current = false
        }

        if (destination && destination !== current) {
          hydra.navigate({ url: `/hydra/${encodeURIComponent(destination)}/` })
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
      hydra.navigate,
      hydra.navigation.page,
      hydra.loaded,
    ],
  )

  useHydraFavicon({ icon: hydra.navigation.hydras.find(item => item.id === current)?.icon })

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
      const opening = hydra.commandFor({ id: destination })({
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
      })
      opening.catch((error: Error) => setRootError(error.message))
      await hydra.navigate({
        url,
        replace,
      })
      const group = document.querySelector<HTMLElement>(`[data-hydra-workspace="${CSS.escape(destination)}"]`)
      group?.scrollIntoView({
        behavior: scrollBehavior(),
        inline: 'start',
        block: 'nearest',
      })
      group?.querySelector<HTMLTextAreaElement>('.hydra-chat textarea')?.focus({ preventScroll: true })
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
      hydra.commandFor,
      hydra.navigate,
    ],
  )

  const choosePolis = async ({ polis }: { polis?: string }) => {
    const destination = orderedHydras.find(item => (item.polis ?? 'shared') === polis)

    if (polis && currentPolis !== polis && destination) {
      try {
        await navigate({ url: `/hydra/${encodeURIComponent(destination.id)}/` })
      } catch (error) {
        rootNotify({ text: error instanceof Error ? error.message : String(error) })

        return
      }
    }

    filterPolis(polis)
  }

  const hydraLayout = preview?.kind === 'hydra' ? `${preview.id}:${preview.over}:${preview.before}` : ''

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
              className="workspace-axis group/axis flex h-dvh snap-x snap-proximity scroll-px-3 items-stretch gap-3 overflow-x-auto overflow-y-hidden overscroll-x-contain scroll-smooth px-3 pt-workspace-axis-top pb-3 data-[dragging]:cursor-grabbing data-[page=settings]:overflow-hidden motion-reduce:scroll-auto max-phone:scroll-px-1.5 max-phone:gap-2 max-phone:px-1.5 max-phone:pt-workspace-axis-phone-top max-phone:pb-1.5 [&.lenis]:snap-none [&.lenis]:scroll-auto [&[data-dragging]_*]:cursor-grabbing! [&[data-dragging]_*]:select-none! [@media(pointer:coarse)]:[&.lenis]:snap-x"
              data-page={hydra.navigation.page}
              aria-label="Hydras"
            >
              <div ref={track} data-sort-surface="hydra-axis" className="workspace-track relative flex h-full w-max items-stretch gap-3 group-data-[page=settings]/axis:invisible">
                {rootError && (
                  <StatusNotice role="alert">{rootError}<IconButton
                    label="Dismiss"
                    onClick={() => setRootError('')}
                    icon="close"
                  />
                  </StatusNotice>
                )}
                <SortGroup id="hydra-axis" items={visibleWorkspaceIds}>
                  {visibleWorkspaces.map(workspace => (
                    <ProfileSurface key={workspace.viewKey} name="workspace" hydraId={workspace.navigation.hydraId}>
                      <WorkspaceInstance
                        polisFilter={shownFilter}
                        filterPolis={choosePolis}
                        active={workspace.navigation.hydraId === current}
                        navigatePage={hydra.navigate}
                        navigate={navigate}
                        edits={shownEdits}
                        preview={preview?.hydra === workspace.navigation.hydraId ? preview : null}
                        hydraLayout={hydraLayout}
                        hydra={hydra}
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

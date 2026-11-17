import { useMotionDuration, MOTION_EASING } from '#web-shared/motion.ts'
import { StatusNotice } from '#web-shared/ui/status-message.tsx'
import { IconButton } from '#web-shared/ui/icon-button.tsx'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { SortableWorkspace, SortGroup, movedOrder, type SortMove } from '#web-shared/ui/sortable.tsx'
import { MotionConfig } from 'motion/react'
import { useSmoothScroll, scrollBehavior } from '#web-shared/ui/smooth-scroll.ts'
import { afterSteadyLayout } from '#web-tasks/scroll-task.ts'
import { projectColumns, taskProjectColumn, compareTasks, nextSibling } from '#web-tasks/project-view.ts'
import { useHydra } from './connection.ts'
import { useHydraEdits } from './hydra-edits.ts'
import { useHydraFavicon } from './hydra-favicon.ts'
import { placements } from './hydra-order.ts'
import { ProfileSurface } from './profile-surface.tsx'
import { HydraView } from './workspace.tsx'

export function App() {
  const duration = useMotionDuration()
  const hydra = useHydra()

  const current = hydra.navigation.hydraId
  const axis = useRef<HTMLDivElement>(null)
  const track = useRef<HTMLDivElement>(null)
  const alignment = useRef<AbortController | null>(null)
  useEffect(
    () => () => alignment.current?.abort(),
    [],
  )
  useSmoothScroll({
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
  const workspaces = [...hydra.workspaces].sort((
    a,
    b,
  ) =>
    orderedHydras.findIndex(item => item.id === a.navigation.hydraId)
    - orderedHydras.findIndex(item => item.id === b.navigation.hydraId))

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

      if (!card || !target) {
        return
      }

      if (preview.nest) {
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
        : columns.find(column => column.id === taskProjectColumn({
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

  const workspaceOrder = workspaces.map(workspace => workspace.navigation.hydraId).join(':')

  useLayoutEffect(
    () => {
      const surface = axis.current
      const inner = track.current
      const group = surface?.querySelector<HTMLElement>(`[data-hydra-workspace="${CSS.escape(current)}"]`)

      if (!hydra.loaded || !surface || !inner || !group) {
        return
      }

      const padding = parseFloat(getComputedStyle(surface).scrollPaddingLeft) || 0
      surface.scrollTo({
        left: group.offsetLeft + inner.offsetLeft - surface.offsetLeft - padding,
        behavior: 'instant',
      })
    },
    [
      current,
      hydra.loaded,
      workspaceOrder,
    ],
  )

  useEffect(
    () => {
      const surface = axis.current

      if (!surface) {
        return
      }

      const follow = () => {
        if (surface.dataset.dragging || hydra.navigation.page === 'settings') {
          return
        }

        const padding = parseFloat(getComputedStyle(surface).scrollPaddingLeft) || 0
        const left = surface.getBoundingClientRect().left + padding
        const destination = [...surface.querySelectorAll<HTMLElement>('[data-hydra-workspace]')]
          .find(element => Math.abs(element.getBoundingClientRect().left - left) < 2)
          ?.dataset.hydraWorkspace

        if (destination && destination !== current) {
          hydra.navigate({ url: `/hydra/${encodeURIComponent(destination)}/` })
            .catch((error: Error) => setRootError(error.message))
        }
      }

      surface.addEventListener(
        'scrollend',
        follow,
      )

      return () => surface.removeEventListener(
        'scrollend',
        follow,
      )
    },
    [
      current,
      hydra.navigate,
      hydra.navigation.page,
    ],
  )

  useHydraFavicon({ icon: hydra.navigation.hydras.find(item => item.id === current)?.icon })

  const navigate = async ({
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
  }

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
        <SortableWorkspace root={axis} move={({ preview }) => setPreview(preview)} drop={drop}>
          <div
            ref={axis}
            className="workspace-axis group/axis data-[dragging]:cursor-grabbing [&[data-dragging]_*]:cursor-grabbing! [&[data-dragging]_*]:select-none! flex h-dvh items-stretch gap-3 overflow-x-auto overflow-y-hidden px-3 pt-[calc(var(--spacing-topbar-height)+var(--spacing)*2.5)] pb-3 snap-x snap-proximity scroll-px-3 overscroll-x-contain scroll-smooth data-[page=settings]:overflow-hidden max-[760px]:gap-2 max-[760px]:px-1.5 max-[760px]:pt-[calc(var(--spacing-topbar-height)+var(--spacing)*2)] max-[760px]:pb-1.5 max-[760px]:scroll-px-1.5 [&.lenis]:snap-none [&.lenis]:scroll-auto motion-reduce:scroll-auto [@media(pointer:coarse)]:[&.lenis]:snap-x"
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
              <SortGroup id="hydra-axis" items={workspaces.map(workspace => workspace.navigation.hydraId)}>
                {workspaces.map(workspace => (
                  <ProfileSurface key={workspace.viewKey} name="workspace" hydraId={workspace.navigation.hydraId}>
                    <HydraView
                      active={workspace.navigation.hydraId === current}
                      navigatePage={hydra.navigate}
                      edits={{
                        ...edits,
                        hydras: orderedHydras,
                      }}
                      preview={preview}
                      hydra={{
                        ...hydra,
                        ...workspace,
                        navigate,
                        command: hydra.commandFor({ id: workspace.navigation.hydraId }),
                      }}
                    />
                  </ProfileSurface>
                ))}
              </SortGroup>
            </div>
          </div>
        </SortableWorkspace>
      </ProfileSurface>
    </MotionConfig>
  )
}

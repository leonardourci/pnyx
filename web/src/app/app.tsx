import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button } from '#web-shared/ui/controls.tsx'
import { Icon } from '#web-shared/ui/icon.tsx'
import { usePhysicalDrag, movedOrder, type PhysicalMove } from '#web-shared/ui/physical-drag.ts'
import { useSmoothScroll, scrollBehavior } from '#web-shared/ui/smooth-scroll.ts'
import { afterSteadyLayout } from '#web-tasks/scroll-task.ts'
import { projectColumns, taskProjectColumn } from '#web-tasks/project-view.ts'
import { useHydra } from './connection.ts'
import { useHydraEdits } from './hydra-edits.ts'
import { useHydraFavicon } from './hydra-favicon.ts'
import { placements } from './hydra-order.ts'
import { reportRender } from './render-log.ts'
import { HydraView } from './workspace.tsx'

export function App() {
  const rendering = performance.now()
  useLayoutEffect(() => reportRender({
    name: 'hydra-workspaces',
    ms: performance.now() - rendering,
  }))
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
  ] = useState<PhysicalMove | null>(null)
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
  usePhysicalDrag({
    root: axis,
    move: ({ preview }) => setPreview(preview),
    drop: ({ preview }) => {
      const commit = async () => {
        if (preview.kind === 'hydra') {
          const index = orderedHydras.findIndex(item => item.id === preview.id)

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

        if (card?.parentId && preview.detach) {
          await command({
            name: 'task',
            args: [
              'parent',
              card.id,
              'none',
              '--event-id',
              event,
            ],
          })

          return
        }

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

        if (card.parentId && !target.parentId) {
          await command({
            name: 'task',
            args: [
              'parent',
              card.id,
              'none',
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
        const next = ordered[ordered.findIndex(item => item.id === card.id) + 1]
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
    },
  })

  useEffect(
    () => {
      if (!hydra.loaded) {
        return
      }

      document.querySelector<HTMLElement>(`[data-hydra-workspace="${CSS.escape(current)}"]`)
        ?.scrollIntoView({
          inline: 'start',
          block: 'nearest',
        })
    },
    [
      current,
      hydra.loaded,
    ],
  )

  useEffect(
    () => {
      const surface = axis.current

      if (!surface) {
        return
      }

      const follow = () => {
        if (surface.dataset.dragging) {
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
    const destination = new URL(
      url,
      location.href,
    ).pathname.split('/')[2]!
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
    const id = new URL(
      url,
      location.href,
    ).pathname.split('/')[2]!
    const group = document.querySelector<HTMLElement>(`[data-hydra-workspace="${CSS.escape(id)}"]`)
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
    <div ref={axis} className="workspace-axis" aria-label="Hydras">
      <div ref={track} className="workspace-track">
        {rootError && <div className="notice" role="alert">{rootError}<Button aria-label="Dismiss" onClick={() => setRootError('')}><Icon name="close" /></Button></div>}
        {workspaces.map(workspace => (
          <HydraView
            key={workspace.viewKey}
            active={workspace.navigation.hydraId === current}
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
        ))}
      </div>
    </div>
  )
}

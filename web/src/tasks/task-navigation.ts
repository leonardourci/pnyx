import { useEffect, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { HydraState } from '#app/model.ts'
import type { Card } from '#tasks/model.ts'
import { liveTask } from '#tasks/select.ts'
import { focusElement } from '#web-preferences/keyboard-registry.tsx'
import { expandedByColumn, columnsFor, filterCards } from './view.ts'
import { openTaskCard, afterTaskLayout, afterSteadyLayout, scrollTask } from './scroll-task.ts'

const VISIBLE_TAB_PANEL = '.card-panel:not([hidden])'

export function useTaskNavigation({
  state,
  selectedRef,
  setActive,
  expanded,
  setExpanded,
  revealed,
  setRevealed,
  page,
  setPage,
  workspace,
  tag,
  project,
  projectReferences,
}: {
  state: HydraState
  selectedRef: string | null
  setActive: Dispatch<SetStateAction<string | null>>
  expanded: string[]
  setExpanded: Dispatch<SetStateAction<string[]>>
  revealed: {
    scope: string
    ids: string[]
  }
  setRevealed: Dispatch<SetStateAction<{
    scope: string
    ids: string[]
  }>>
  page: string
  setPage: Dispatch<SetStateAction<string>>
  workspace: string
  tag: string
  project: string
  projectReferences: string[]
}) {
  const selected = selectedRef ? state.keys[selectedRef] ?? selectedRef : null
  const currentCards = useRef(state.cards)
  currentCards.current = state.cards
  const pendingColumns = useRef<Record<string, string>>({})
  const pendingFocus = useRef<string | null>(null)
  const pendingOpen = useRef<AbortController | null>(null)
  const highlight = useRef<Animation | null>(null)
  const [
    revealing,
    setRevealing,
  ] = useState<string | null>(null)

  const cancelOpen = () => {
    pendingOpen.current?.abort(); pendingOpen.current = null
    highlight.current?.cancel(); highlight.current = null
    setRevealing(null)
  }

  useEffect(
    () => () => {
      pendingOpen.current?.abort(); pendingOpen.current = null
      highlight.current?.cancel(); highlight.current = null
    },
    [],
  )
  useEffect(
    () => {
      if (page !== 'hydra') {
        cancelOpen()
      }
    },
    [page],
  )

  const clearSelection = () => {
    cancelOpen(); setActive(null); setExpanded([]); pendingFocus.current = null
  }

  const expandedIds = expandedByColumn({
    ids: expanded.map(id => state.keys[id] ?? id),
    cards: state.cards,
    pending: pendingColumns.current,
  })
  useEffect(
    () => {
      // eslint-disable-next-line pnyx/object-params -- React state setter callback contract.
      setExpanded(ids => {
        const next = expandedByColumn({
          ids: ids.map(id => state.keys[id] ?? id),
          cards: state.cards,
          pending: pendingColumns.current,
        })

        return ids.length === next.length && ids.every((
          id,
          index,
        ) => id === next[index]) ? ids : next
      })
    },
    [state.cards],
  )
  useLayoutEffect(() => {
    const pendingId = pendingFocus.current
    const id = pendingId ? state.keys[pendingId] ?? pendingId : null

    if (page !== 'hydra' || !id) {
      return
    }

    const element = document.querySelector<HTMLElement>(`.card[data-task="${CSS.escape(id)}"].selected`)
    const panel = element?.querySelector<HTMLElement>(VISIBLE_TAB_PANEL)

    if (panel) {
      pendingFocus.current = null
      requestAnimationFrame(() => {
        panel.focus({ preventScroll: true })
      })
    }
  })
  const columns = columnsFor({ state })
  const filteredCards = filterCards({
    state,
    workspace,
    tag,
  }).filter(c => !project || c.project === project || projectReferences.includes(c.project ?? ''))
  const filterScope = JSON.stringify([
    workspace,
    tag,
    project,
  ])
  useEffect(
    () => {
      if (revealed.scope && revealed.scope !== filterScope) {
        setRevealed({
          scope: '',
          ids: [],
        })
      }
    },
    [
      filterScope,
      revealed.scope,
    ],
  )
  const revealedIds = revealed.scope === filterScope ? revealed.ids.filter(id => {
    const card = state.cards[id]

    return !!card && liveTask({ card })
  }) : []
  const cards = [
    ...filteredCards,
    ...[
      ...new Set([
        ...expandedIds,
        ...revealedIds,
        ...(revealing ? [revealing] : []),
      ]),
    ]
      .map(id => state.cards[id]).filter((item): item is Card =>
        !!item && !filteredCards.some(card => card.id === item.id)),
  ]

  const openHydra = () => {
    cancelOpen(); setPage('hydra')
    requestAnimationFrame(() => focusElement({ selector: '.hydra-chat textarea' }))
  }

  const keepRevealed = ({ id }: { id: string }) => {
    const card = currentCards.current[id]

    if (card && liveTask({ card }) && !filteredCards.some(card => card.id === id)) {
      // eslint-disable-next-line pnyx/object-params -- React state setter callback contract.
      setRevealed(kept => ({
        scope: filterScope,
        ids: [
          ...new Set([
            ...(kept.scope === filterScope ? kept.ids : []),
            id,
          ]),
        ],
      }))
    }
  }

  const expand = ({
    id,
    column,
    focus = true,
  }: {
    id: string
    column?: string
    focus?: boolean
  }) => {
    if (column) {
      pendingColumns.current[id] = column
    }

    keepRevealed({ id })
    pendingFocus.current = focus ? id : null
    // eslint-disable-next-line pnyx/object-params -- React state setter callback contract.
    setExpanded(ids => expandedByColumn({
      ids: [
        ...ids.filter(item => item !== id),
        id,
      ],
      cards: currentCards.current,
      pending: pendingColumns.current,
    }))
    setActive(id); setPage('hydra')
  }

  const openFromPointer = ({
    id,
    signal,
  }: {
    id: string
    signal: AbortSignal
  }) => openTaskCard({
    find: () => (currentCards.current[id]
      ? document.querySelector<HTMLElement>(`.card[data-task="${CSS.escape(id)}"]`) : null),
    expand: () => expand({
      id,
      focus: false,
    }),
    settle: () => afterTaskLayout({ signal }),
    opened: ({ element }) => element.querySelector<HTMLElement>(VISIBLE_TAB_PANEL)
      ?.focus({ preventScroll: true }),
    align: async ({ element }) => await afterSteadyLayout({
      element,
      signal,
    }) && scrollTask({
      element,
      signal,
    }),
    signal,
  })

  const open = async ({
    id,
    pointer = false,
    focusPanel = true,
  }: {
    id: string
    pointer?: boolean
    focusPanel?: boolean
  }): Promise<boolean> => {
    cancelOpen(); pendingFocus.current = null

    if (id === '$board') {
      openHydra()

      return true
    }

    if (!state.cards[id]) {
      return false
    }

    const controller = new AbortController()
    const { signal } = controller
    pendingOpen.current = controller
    setPage('hydra'); setRevealing(id)

    try {
      if (pointer) {
        const card = await openFromPointer({
          id,
          signal,
        })

        return !!card?.querySelector(VISIBLE_TAB_PANEL)
      }

      if (!await afterTaskLayout({ signal })) {
        return false
      }

      const element = document.querySelector<HTMLElement>(`.card[data-task="${CSS.escape(id)}"]`)

      if (!element || !await scrollTask({
        element,
        signal,
      })) {
        return false
      }

      if (!currentCards.current[id] || signal.aborted) {
        return false
      }

      expand({
        id,
        focus: false,
      })

      if (!await afterTaskLayout({ signal })) {
        return false
      }

      const panel = element.querySelector<HTMLElement>(VISIBLE_TAB_PANEL)

      if (focusPanel) {
        panel?.focus({ preventScroll: true })
      }

      return !!panel && element.isConnected && !signal.aborted
    } finally {
      if (pendingOpen.current === controller) {
        pendingOpen.current = null; setRevealing(null)
      }
    }
  }

  const revealTask = async ({ id }: { id: string }) => {
    if (!await open({ id })) {
      return
    }

    const element = document.querySelector<HTMLElement>(`.card[data-task="${CSS.escape(id)}"].selected`)

    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches && element) {
      highlight.current = element.animate(
        [
          { boxShadow: '0 0 0 3px var(--color-gold-line)' },
          { boxShadow: '0 0 0 0 transparent' },
        ],
        {
          duration: 1200,
          easing: 'ease-out',
        },
      )
    }
  }

  const close = ({ id = selected }: { id?: string | null } = {}) => {
    if (!id) {
      return
    }

    cancelOpen()
    const closing = state.cards[id]

    keepRevealed({ id })

    const remaining = expandedIds.filter(item => item !== id)
    const target = closing && liveTask({ card: closing }) ? closing
      : filteredCards.find(c => c.column === closing?.column) ?? filteredCards[0]
    setExpanded(remaining)

    if (selected === id) {
      setActive(remaining.at(-1) ?? null)
    }

    if (pendingFocus.current === id) {
      pendingFocus.current = null
    }

    requestAnimationFrame(() => focusElement({ selector: target ? `[data-card="${CSS.escape(target.id)}"]` : `[data-column-heading="${CSS.escape(closing?.column ?? 'needs_you')}"]` }))
  }

  return {
    selected,
    expandedIds,
    cards,
    columns,
    filteredCards,
    cancelOpen,
    clearSelection,
    expand,
    open,
    revealTask,
    close,
    openHydra,
  }
}

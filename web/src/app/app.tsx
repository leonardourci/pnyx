import { useEffect, useState, useRef, useLayoutEffect, useCallback, type CSSProperties } from 'react'
import { useHydra } from './connection.ts'
import { useInstallationPending } from '#web-workers/dispatch-resource.ts'
import { useProjectsResource } from '#web-projects/project-resource.ts'
import { storageKey } from '#web-hydra/outbox.ts'
import { hydraViews, restoreView, readComments, savedComments, scrollers, type Restore } from './restore.ts'
import { pageTitle, hydraTitle } from './view.ts'
import { SettingsPage } from '#web-settings/settings-page.tsx'
import { expandedByColumn, columnsFor, filterCards } from '#web-tasks/view.ts'
import { sendableComment, type ChatComment } from '#web-hydra/chat.ts'
import { TaskCreate, type TaskDraft } from '#web-tasks/task-create.tsx'
import { viewFor } from '#preferences/view.ts'
import { pnyxLookup } from '#web-hydra/pnyx-action.ts'
import { useTaskReferences } from '#web-tasks/task-references.ts'
import { liveTask } from '#tasks/select.ts'
import type { Card } from '#tasks/model.ts'
import { focusElement, KeyboardProvider } from '#web-preferences/keyboard-registry.tsx'
import { openTaskCard, afterTaskLayout, afterSteadyLayout, scrollTask } from '#web-tasks/scroll-task.ts'
import { argument } from '#web-tasks/optimistic.ts'
import { useHydraKeyboard } from '#web-preferences/keyboard-hydra.tsx'
import { lockedColumn } from '#tasks/column-rules.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { HYDRA_MARK } from '#hydra/hydra-names.ts'
import { taskMention } from '#hydra/mentions.ts'
import { Panel } from './panel.tsx'
import { UPGRADE_COMMAND } from '#upgrade/model.ts'
import { Oracle } from '#web-oracle/oracle.tsx'
import { Hydras } from './hydras.tsx'
import { useHydraEdits } from './hydra-edits.ts'
import { useHydraFavicon } from './hydra-favicon.ts'
import { Button } from '#web-shared/ui/controls.tsx'
import { PendingStatus } from '#web-shared/ui/pending-status.tsx'
import { HydraLabel } from '#web-hydra/hydra-title.tsx'
import { HydraChat } from '#web-hydra/hydra-chat.tsx'
import { TaskReferencesProvider } from '#web-tasks/task-reference.tsx'
import { Column } from '#web-tasks/column.tsx'
import { HydraCard } from '#web-tasks/card.tsx'
import { Detail } from '#web-tasks/detail.tsx'
import { Icon } from '#web-shared/ui/icon.tsx'
import { useSharedSettings, saveSharedSettings } from '#web-settings/shared-settings.ts'
import { pickView } from '#settings/settings.ts'
import { isSharedViewKey } from '#settings/model.ts'

const VISIBLE_TAB_PANEL = '.card-panel:not([hidden])'

export function App() {
  const hydra = useHydra()

  return <HydraView key={hydra.viewKey} hydra={hydra} />
}

function HydraView({ hydra }: { hydra: ReturnType<typeof useHydra> }) {
  const {
    state,
    command,
    connected,
    hydraThread,
    hydraQueue,
    upgrade,
    latest,
    actions,
    navigation,
    navigate,
    loading,
    loaded,
    error,
    checking,
  } = hydra
  useEffect(
    () => {
      if (hydra.creating) {
        const frame = requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.hydra-chat textarea')?.focus())

        return () => cancelAnimationFrame(frame)
      }
    },
    [hydra.viewKey],
  )
  const installationPending = useInstallationPending()
  const { intents: projectPending } = useProjectsResource({
    command,
    connected,
    revision: state.projectsRevision,
  })
  const restoreKey = storageKey({ key: 'restore' })
  const commentsKey = storageKey({
    key: 'comments',
    hydraId: navigation.hydraId,
  })
  const [restored] = useState(() => hydraViews.get(hydra.viewKey)
    ?? restoreView({ key: restoreKey }))
  const [
      page,
      setPage,
    ] = useState(() => new URLSearchParams(location.search).has('settings') || restored.page === 'settings' ? 'settings' : 'hydra'), [
      workspace,
      setWorkspace,
    ] = useState(''), [
      tag,
      setTag,
    ] = useState('')
  const [
      selectedRef,
      setActive,
    ] = useState<string | null>(new URLSearchParams(location.search).has('open-project') ? null : restored.selected ?? restored.expanded?.at(-1) ?? null), [
      drafts,
      setDrafts,
    ] = useState<Record<string,string>>(restored.drafts ?? {}), [
      notice,
      setNotice,
    ] = useState<{ text: string } | null>(null), [
      newColumn,
      setNewColumn,
    ] = useState<string | null>(null)
  const [
    expanded,
    setExpanded,
  ] = useState<string[]>(new URLSearchParams(location.search).has('open-project')
    ? [] : restored.expanded ?? (restored.selected ? [restored.selected] : []))
  const [
    revealed,
    setRevealed,
  ] = useState<{
    scope: string
    ids: string[]
  }>(restored.revealed ?? {
    scope: '',
    ids: [],
  })
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
  const [
    comments,
    setComments,
  ] = useState<Record<string, ChatComment[]>>(() => {
    try {
      return readComments({ value: localStorage.getItem(commentsKey) })
    } catch {
      return {}
    }
  })
  // Another tab's edits arrive here, so the next write from this tab doesn't undo them.
  useEffect(
    () => {
      const sync = ({
        key,
        newValue,
      }: StorageEvent) => {
        if (key !== commentsKey || newValue === JSON.stringify(savedComments({ comments }))) {
          return
        }

        setComments(current => {
          const incoming = readComments({ value: newValue })

          for (const [
            card,
            items,
          ] of Object.entries(current)) {
            const pending = items.filter(comment => !sendableComment({ comment })
                && !incoming[card]?.some(item => item.id === comment.id))

            if (pending.length) {
              incoming[card] = [
                ...incoming[card] ?? [],
                ...pending,
              ]
            }
          }

          return incoming
        })
      }

      addEventListener(
        'storage',
        sync,
      )

      return () => removeEventListener(
        'storage',
        sync,
      )
    },
    [
      comments,
      commentsKey,
    ],
  )
  useEffect(
    () => {
      try {
        localStorage.setItem(
          commentsKey,
          JSON.stringify(savedComments({ comments })),
        )
      } catch { /* Storage full or blocked: comments last until the tab closes. */ }
    },
    [
      comments,
      commentsKey,
    ],
  )
  const [
    creatingTask,
    setCreatingTask,
  ] = useState<{
    column: string
    parent?: string
    draft?: TaskDraft
    version: number
  } | null>(null)
  const taskFormVersion = useRef(0)
  // Another Hydra's Add project request waits in the URL until that Hydra opens.
  const [
    projectRequest,
    setProjectRequest,
  ] = useState(new URLSearchParams(location.search).has('add-project'))
  const [
    panel,
    setPanel,
  ] = useState(restored.panel ?? true)
  // The search Settings opens with when the Oracle sends a setting there; it also remounts the page for it.
  const [
    settingsQuery,
    setSettingsQuery,
  ] = useState('')
  // The Oracle's palette draws inside the page, so it takes the page's text sizes.
  const [
    layer,
    setLayer,
  ] = useState<HTMLDivElement | null>(null)
  const [
    project,
    setProject,
  ] = useState(new URLSearchParams(location.search).get('open-project') ?? new URLSearchParams(location.search).get('project') ?? '')
  const [
    projectReferences,
    setProjectReferences,
  ] = useState<string[]>([])
  const resolveProject = useCallback(
    ({ references }: { references: string[] }) => {
      setProjectReferences(references)
    },
    [],
  )
  useEffect(
    () => {
      const url = new URL(location.href)

      if (url.searchParams.has('add-project')) {
        url.searchParams.delete('add-project')
      }

      // ?settings opens Settings once; leaving it and reloading returns to the Hydra.
      url.searchParams.delete('settings')

      const project = url.searchParams.get('open-project')

      if (project !== null) {
        url.searchParams.delete('open-project'); url.searchParams.set(
          'project',
          project,
        )
      }

      history.replaceState(
        null,
        '',
        url,
      )
    },
    [],
  )

  const filterProject = ({ path }: { path: string }) => {
    setProject(path)
    const url = new URL(location.href)

    if (path) {
      url.searchParams.set(
        'project',
        path,
      )
    } else {
      url.searchParams.delete('project')
    }

    history.replaceState(
      null,
      '',
      url,
    )
  }

  useEffect(
    () => {
      if (!notice) {
        return
      }

      const timer = setTimeout(
        () => setNotice(null),
        5000,
      )

      return () => clearTimeout(timer)
    },
    [notice],
  )

  const notify = useCallback(
    ({ text }: { text: string }) => {
      setNotice({ text })
    },
    [],
  )
  const edits = useHydraEdits({
    hydras: navigation.hydras,
    command,
    notify,
  })
  useEffect(
    () => {
      if (projectRequest && state.config?.hydra.kind === 'firstmate') {
        notify({ text: 'Firstmate manages this Hydra’s projects.' }); setProjectRequest(false)
      }
    },
    [
      projectRequest,
      state.config?.hydra.kind,
      notify,
    ],
  )
  useEffect(
    () => {
      const timers = new Map<HTMLElement, ReturnType<typeof setTimeout>>()

      const scroll = (event: Event) => {
        const target = event.target

        if (!(target instanceof HTMLElement)) {
          return
        }

        clearTimeout(timers.get(target)); target.classList.add('scrolling')
        timers.set(
          target,
          setTimeout(
            () => {
              target.classList.remove('scrolling'); timers.delete(target)
            },
            700,
          ),
        )
      }

      document.addEventListener(
        'scroll',
        scroll,
        true,
      )

      return () => {
        document.removeEventListener(
          'scroll',
          scroll,
          true,
        ); timers.forEach(timer => clearTimeout(timer))
      }
    },
    [],
  )
  useLayoutEffect(
    () => () => {
      const value: Restore = {
        selected,
        expanded,
        revealed,
        page,
        panel,
        drafts,
        scroll: Object.fromEntries(scrollers()
          .map(([
            key,
            el,
          ]) => [
            key,
            [
              el.scrollLeft,
              el.scrollTop,
            ],
          ])),
      }
      hydraViews.set(
        hydra.viewKey,
        value,
      )

      try {
        sessionStorage.setItem(
          restoreKey,
          JSON.stringify(value),
        )
      } catch { /* The in-memory view still preserves drafts when storage is full. */ }
    },
    [
      hydra.viewKey,
      selected,
      expanded,
      revealed,
      page,
      panel,
      drafts,
      restoreKey,
    ],
  )
  const pendingScroll = useRef(restored.scroll)
  const shared = useSharedSettings()
  const view = viewFor({
    state,
    settings: shared && pickView({ view: shared }),
  })
  const lookup = pnyxLookup({ state })
  const references = useTaskReferences({ state })
  useEffect(
    () => {
      const root = document.documentElement, dark = matchMedia('(prefers-color-scheme: dark)')

      const apply = () => {
        root.dataset.theme = view.theme === 'system' ? (dark.matches ? 'dark' : 'light') : view.theme
      }

      apply(); dark.addEventListener(
        'change',
        apply,
      )

      return () => dark.removeEventListener(
        'change',
        apply,
      )
    },
    [view.theme],
  )
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

  const startUpgrade = async () => {
    try {
      await command({
        name: 'hydra',
        args: [
          'send',
          `--text=${UPGRADE_COMMAND}`,
          '--event-id',
          crypto.randomUUID(),
        ],
      })
    } catch (error) {
      notify({ text: (error as Error).message })
    }
  }

  const shownHydra = edits.hydras.find(h => h.id === navigation.hydraId)
  const title = pageTitle({
    page,
    cards: state.cards,
    selected,
    needsYou: columns.find(c => c.role === 'needs_you')?.id,
    hydra: shownHydra && hydraTitle(shownHydra),
  })
  useHydraFavicon({ icon: shownHydra?.icon })
  useEffect(
    () => {
      document.title = title
    },
    [title],
  )
  const save = useCallback(
    async ({ patch }: { patch: Record<string, unknown> }) => {
      const entries = Object.entries(patch)
      const sharedPatch = Object.fromEntries(entries.filter(([key]) => isSharedViewKey({ key })))
      const boardPatch = Object.fromEntries(entries.filter(([key]) => !isSharedViewKey({ key })))

      const writes = []

      if (Object.keys(sharedPatch).length) {
        writes.push(saveSharedSettings({
          command,
          patch: sharedPatch,
        }))
      }

      if (Object.keys(boardPatch).length) {
        writes.push(command({
          name: 'view',
          args: [
            'set',
            '--json',
            JSON.stringify(boardPatch),
            '--if-revision',
            String(state.viewRevision ?? 0),
            '--event-id',
            crypto.randomUUID(),
          ],
        }))
      }

      try {
        await Promise.all(writes)

        return true
      } catch (error) {
        notify({ text: (error as Error).message })

        return false
      }
    },
    [
      command,
      notify,
      state.viewRevision,
    ],
  )

  useEffect(
    () => {
      const keep = () => {
        try {
          const scroll = Object.fromEntries(scrollers()
            .map(([
              key,
              el,
            ]) => [
              key,
              [
                el.scrollLeft,
                el.scrollTop,
              ],
            ]))
          sessionStorage.setItem(
            restoreKey,
            JSON.stringify({
              selected,
              expanded,
              revealed,
              page,
              panel,
              drafts,
              scroll,
            }),
          )
        } catch { /* Storage full or blocked: the reload starts fresh. */ }
      }

      addEventListener(
        'pagehide',
        keep,
      )

      return () => removeEventListener(
        'pagehide',
        keep,
      )
    },
    [
      selected,
      expanded,
      revealed,
      page,
      panel,
      drafts,
      restoreKey,
    ],
  )
  useEffect(
    () => {
      const scroll = pendingScroll.current

      if (scroll && state.seq > 0) {
        pendingScroll.current = undefined
        requestAnimationFrame(() => {
          for (const [
            key,
            el,
          ] of scrollers()) {
            const [
              left,
              top,
            ] = scroll[key] ?? [
              0,
              0,
            ]
            el.scrollTo({
              left,
              top,
              behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
            })
          }
        })
      }
    },
    [state.seq],
  )

  const openHydra = () => {
    cancelOpen(); setPage('hydra')
    requestAnimationFrame(() => focusElement({ selector: '.hydra-chat textarea' }))
  }

  const keepRevealed = ({ id }: { id: string }) => {
    const card = currentCards.current[id]

    if (card && liveTask({ card }) && !filteredCards.some(card => card.id === id)) {
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

  const createTask = ({
    column,
    parent,
  }: {
    column: string
    parent?: string
  }) => {
    setPage('hydra'); setWorkspace(''); setTag(''); filterProject({ path: '' }); clearSelection()
    taskFormVersion.current++
    const refused = hydra.edits.findLast(intent => {
      const {
        name,
        args,
      } = intent.patch
      const attempt = argument({
        args,
        flag: '--event-id',
      }) ?? intent.id
      const matchesForm = argument({
        args,
        flag: '--column',
      }) === column
        && argument({
          args,
          flag: '--parent',
        }) === parent

      return intent.stage === 'refused' && name === 'task' && args[0] === 'create'
        && matchesForm && !state.keys[`task:${attempt}`]
    })
    const draft = refused && {
      title: argument({
        args: refused.patch.args,
        flag: '--title',
      }) ?? '',
      prompt: argument({
        args: refused.patch.args,
        flag: '--ask',
      }) ?? '',
      attempt: argument({
        args: refused.patch.args,
        flag: '--event-id',
      }) ?? refused.id,
    }
    setCreatingTask({
      column,
      version: taskFormVersion.current,
      draft,
      ...(parent ? { parent } : {}),
    })
    requestAnimationFrame(() => requestAnimationFrame(() => focusElement({ selector: '.task-create [aria-label="Task title"]' })))
  }

  const createColumn = () => {
    const id = `custom:${crypto.randomUUID()}`
    setPage('hydra'); setNewColumn(id)
    void command({
      name: 'column',
      args: [
        'create',
        '--id',
        id,
        '--title',
        'New column',
        '--if-revision',
        String(state.configRevision ?? 0),
        '--event-id',
        crypto.randomUUID(),
      ],
    }).catch((error: Error) => {
      setNewColumn(current => current === id ? null : current)
      notify({ text: error.message })
    })
  }

  const keyboard = useHydraKeyboard({
    state,
    groups: columns.map(c => ({
      id: c.id,
      cards: cards.filter(card => card.column === c.id).map(card => card.id),
    })),
    page,
    setPage: ({ page }) => setPage(page),
    selected,
    open,
    close,
    command,
    connected,
    notify,
    newColumn: newColumn !== null,
    cancelColumn: () => setNewColumn(null),
    togglePanel: () => setPanel(shown => !shown),
  })

  const answerTask = ({ card }: { card: Card }) => {
    setPanel(true)
    setDrafts(drafts => ({
      ...drafts,
      [HYDRA_CARD]: `${drafts[HYDRA_CARD] || ''}\nFor ${taskMention({
        id: card.id,
        title: card.title,
      })}: `.trimStart(),
    }))
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.hydra-chat textarea')?.focus())
  }

  const answerTaskById = ({ id }: { id: string }) => {
    const card = state.cards[id]

    if (!card) {
      return
    }

    open({
      id,
      focusPanel: false,
    })
    answerTask({ card })
  }

  const openSettings = ({ query }: { query: string }) => {
    setSettingsQuery(query); setPage('settings')
    requestAnimationFrame(() => focusElement({ selector: '.settings-page .search-bar-input' }))
  }

  const selectProject = ({ path }: { path: string }) => {
    filterProject({ path }); clearSelection(); setPage('hydra')
  }

  const askInChat = ({ text }: { text: string }) => {
    setPage('hydra')
    setDrafts(drafts => ({
      ...drafts,
      [HYDRA_CARD]: `${drafts[HYDRA_CARD] || ''}\n${text}`.trimStart(),
    }))
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.hydra-chat textarea')?.focus())
  }

  // The same command Hydra's composer sends the owner's message with, scoped to the chosen Hydra.
  const askHydra = ({
    id,
    text,
  }: {
    id: string
    text: string
  }) => hydra.commandFor({ id })({
    name: 'hydra',
    args: [
      'send',
      `--text=${text}`,
      '--event-id',
      crypto.randomUUID(),
    ],
  })

  const openChat = async ({ id }: { id: string }) => {
    if (id === navigation.hydraId) {
      openHydra()

      return
    }

    try {
      await navigate({
        url: new URL(
          `/hydra/${encodeURIComponent(id)}/`,
          location.href,
        ).href,
      })
      requestAnimationFrame(() => focusElement({ selector: '.hydra-chat textarea' }))
    } catch (error) {
      notify({ text: (error as Error).message })
    }
  }

  // The Oracle names the Hydra as its list does, never by its id.
  const oracleHydra = {
    id: navigation.hydraId,
    name: shownHydra ? hydraTitle(shownHydra) : 'Hydra',
    icon: shownHydra?.icon ?? HYDRA_MARK,
  }
  const askTargets = edits.hydras.map(h => ({
    id: h.id,
    name: hydraTitle(h),
    icon: h.icon ?? HYDRA_MARK,
  }))
  const opening = navigation.hydras.find(h => h.id === loading)
  const currentHydra = shownHydra
  const others = edits.hydras.filter(h => h.id !== navigation.hydraId)
  const otherProjects = others.flatMap(h => h.projects.map(p => ({
    name: p.name,
    path: p.path,
    hydra: hydraTitle(h),
  })))

  const addProject = async ({ id }: { id: string }) => {
    if (id === navigation.hydraId) {
      setPage('hydra'); setProjectRequest(true)

      return
    }

    const url = new URL(
      `/hydra/${encodeURIComponent(id)}/`,
      location.href,
    )
    url.searchParams.set(
      'add-project',
      '1',
    )

    try {
      await navigate({ url: url.href })
    } catch (error) {
      notify({ text: (error as Error).message })
    }
  }

  return (
    <KeyboardProvider
      prefs={view.keyboard}
      onAction={keyboard.onAction}
      leaveField={keyboard.leaveField}
      hints={keyboard.hints.length > 0}
      hintKey={keyboard.hintKey}
    >
      <div
        ref={setLayer}
        className="app"
        data-seq={state.seq}
        data-connected={connected}
        style={{
          '--text-ui': `${view.fontSize}px`,
          '--text-chat': `${view.chatFontSize}px`,
          '--text-code': `${view.codeFontSize}px`,
        } as CSSProperties}
      >
        <Panel
          shown={panel}
          connected={connected}
          upgrade={upgrade}
          startUpgrade={startUpgrade}
          page={page}
          navigate={({ page }) => {
            setSettingsQuery(''); setPage(page)
          }}
          oracle={(
            <Oracle
              state={state}
              view={view}
              command={command}
              connected={connected}
              hydra={oracleHydra}
              projects={shownHydra?.projects ?? []}
              workspace={workspace}
              layer={layer}
              save={save}
              notify={notify}
              upgrade={upgrade}
              startUpgrade={startUpgrade}
              openTask={open}
              answerTask={answerTaskById}
              openHydra={openHydra}
              selectProject={selectProject}
              openSettings={openSettings}
              createTask={createTask}
              createColumn={createColumn}
              action={keyboard.onAction}
              hydras={askTargets}
              send={askHydra}
              openChat={openChat}
            />
          )}
        >
          <Hydras
            createHydra={hydra.createHydra}
            editHydra={edits.edit}
            moveHydra={edits.move}
            command={command}
            connected={connected}
            notify={notify}
            hydras={edits.hydras}
            current={navigation.hydraId}
            navigate={navigate}
            loading={!!loading}
            project={project}
            resolveProject={resolveProject}
            selectProject={({ path }) => {
              filterProject({ path: project === path ? '' : path }); clearSelection(); setPage('hydra')
            }}
            showHydra={() => {
              setPage('hydra'); filterProject({ path: '' })
            }}
            addProject={addProject}
          />
        </Panel>
        <main
          className="shell"
          aria-busy={!!loading || !loaded}
          data-hydra={navigation.hydraId}
          data-provisional={hydra.creating || undefined}
        >
          {(loading || !loaded) && (
            <p className="loading-status" role="status">
              {hydra.creating ? 'Creating Hydra' : <>Loading {opening ? <HydraLabel name={opening.name} icon={opening.icon} size={14} /> : 'Hydra'}</>}…
            </p>
          )}
          {error && <p className="error-banner" role="alert">{error} <Button onClick={hydra.retryHydra}>Retry connection</Button></p>}
          {checking && <p className="save-checking loading-status" role="status">Checking whether your changes were saved. Retrying automatically.</p>}
          <PendingStatus
            intents={[
              ...hydra.intents,
              ...installationPending,
              ...projectPending,
            ]}
          />
          {page === 'hydra' && (
            <>
              <div className="hydra-page">
                <HydraChat
                  identity={currentHydra && {
                    name: currentHydra.name,
                    icon: currentHydra.icon,
                    taken: edits.hydras.filter(h => h.id !== currentHydra.id).map(h => h.name),
                  }}
                  editHydra={({
                    name,
                    icon,
                  }) => edits.edit({
                    id: navigation.hydraId,
                    name,
                    icon,
                  })}
                  addProject={() => addProject({ id: navigation.hydraId })}
                  projectRequest={projectRequest}
                  projectRequested={() => setProjectRequest(false)}
                  otherProjects={otherProjects}
                  state={state}
                  liveThread={hydraThread}
                  action={actions[HYDRA_CARD]}
                  queue={hydraQueue}
                  command={command}
                  connected={connected}
                  openTask={revealTask}
                  notify={notify}
                  view={view}
                  save={save}
                  draft={drafts[HYDRA_CARD] ?? ''}
                  setDraft={({ text }) => setDrafts(d => ({
                    ...d,
                    [HYDRA_CARD]: text,
                  }))}
                  comments={comments[HYDRA_CARD] ?? []}
                  setComments={({ items }) => setComments(c => ({
                    ...c,
                    [HYDRA_CARD]: items,
                  }))}
                />
                <TaskReferencesProvider references={references} openTask={revealTask}>
                  <div className="hydra-main">
                    <div className="work-area inline">
                      <div className="hydra-space">
                        <div className="kanban" aria-label="Work columns">
                          {columns.map(c => {
                            const items = cards.filter(card => card.column === c.id)

                            return (
                              <Column
                                key={c.id}
                                {...c}
                                cards={items}
                                view={view}
                                save={save}
                                command={command}
                                notify={notify}
                                revision={state.configRevision ?? 0}
                                connected={connected}
                                columnIds={columns.map(c => c.id)}
                                locked={lockedColumn({
                                  state,
                                  id: c.id,
                                })}
                                editingTitle={newColumn === c.id}
                                titleFinished={() => setNewColumn(null)}
                                createTask={createTask}
                              >
                                {creatingTask?.column === c.id && (
                                  <TaskCreate
                                    key={`${c.id}:${creatingTask.parent ?? ''}`}
                                    {...creatingTask}
                                    command={command}
                                    connected={connected}
                                    notify={notify}
                                    cancel={() => setCreatingTask(null)}
                                    recover={({ draft }) => {
                                      if (taskFormVersion.current === creatingTask.version) {
                                        setCreatingTask({
                                          ...creatingTask,
                                          draft,
                                        })
                                      }

                                      const key = `task:${draft.attempt}`
                                      setActive(current => current === key ? null : current)
                                      setExpanded(ids => ids.filter(id => id !== key))
                                    }}
                                    submitted={({ id }) => {
                                      setCreatingTask(null); expand({
                                        id,
                                        column: c.id,
                                      })
                                      const first = items[0]

                                      if (first) {
                                        void command({
                                          name: 'move',
                                          args: [
                                            id,
                                            c.id,
                                            '--before',
                                            first.id,
                                            '--event-id',
                                            crypto.randomUUID(),
                                          ],
                                        }).catch(e => notify({ text: e.message }))
                                      }
                                    }}
                                  />
                                )}
                                {items.map(item => (
                                  <HydraCard
                                    key={item.key}
                                    card={item}
                                    labelColors={state.labelColors}
                                    doneAfterHours={shared?.doneAfterHours}
                                    notify={notify}
                                    latest={latest[item.id]}
                                    action={actions[item.id]}
                                    lookup={lookup}
                                    answer={answerTask}
                                    selected={expandedIds.includes(item.id)}
                                    onEdit={cancelOpen}
                                    recoverSelection={({ id }) => {
                                      setActive(current => current ?? id)
                                      setExpanded(ids => ids.length ? ids : [id])
                                    }}
                                    view={view}
                                    save={save}
                                    open={({
                                      id,
                                      pointer,
                                      focusPanel,
                                    }) => {
                                      if (expandedIds.includes(id)) {
                                        close({ id })

                                        return Promise.resolve(false)
                                      }

                                      return open({
                                        id,
                                        pointer,
                                        focusPanel,
                                      })
                                    }}
                                    command={command}
                                    connected={connected}
                                    tabIndex={
                                      (items.some(i => i.id === keyboard.remembered[c.id])
                                        ? keyboard.remembered[c.id]
                                        : items[0]?.id) === item.id ? 0 : -1
                                    }
                                  >
                                    {expandedIds.includes(item.id) && (
                                      <Detail
                                        card={item}
                                        state={state}
                                        command={command}
                                        connected={connected}
                                      />
                                    )}
                                  </HydraCard>
                                ))}
                              </Column>
                            )
                          })}
                          <div className="add-column">
                            <Button
                              disabled={!connected}
                              onClick={createColumn}
                            ><Icon name="plus" />Add column
                            </Button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </TaskReferencesProvider>
              </div>
            </>
          )}
          {page === 'settings' && (
            <SettingsPage
              key={settingsQuery}
              initialQuery={settingsQuery}
              state={state}
              connected={connected}
              view={view}
              save={save}
              command={command}
              notify={notify}
              upgrade={upgrade}
              startUpgrade={startUpgrade}
            />
          )}
        </main>
        {notice && (
          <div className="notice" role="status">
            <span>{notice.text}</span>
            <Button aria-label="Dismiss notification" onClick={() => setNotice(null)}>
              <Icon name="close" />
            </Button>
          </div>
        )}
      </div>
    </KeyboardProvider>
  )
}

import type { Card } from '../../../src/core/model.ts'
import { Icon } from '../components/ui/icon.tsx'
import { storageKey } from './outbox.ts'
import { HYDRA_CARD, lockedColumn } from '../../../src/core/hydra.ts'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { liveTask } from '../../../src/core/tasks.ts'
import { viewFor } from '../../../src/core/view.ts'
import { Button } from '../components/ui/controls.tsx'
import { AddProject } from './add-project.tsx'
import { HydraChat } from './hydra-chat.tsx'
import { useHydra } from './connection.ts'
import { HydraCard } from './card.tsx'
import { TaskCreate } from './task-create.tsx'
import { Column } from './column.tsx'
import { Detail } from './detail.tsx'
import type { ChatComment } from './chat.ts'
import { Settings } from './settings.tsx'
import { Hydras } from './hydras.tsx'
import { Panel } from './panel.tsx'
import { History } from './history.tsx'
import { columnsFor, findBoxCards, pageTitle } from './view.ts'
import { Oracle } from './oracle.tsx'
import { commandQuery } from './oracle-catalog.ts'
import { useFoundCards } from './card-oracle.ts'
import { KeyboardProvider, focusElement } from '../keyboard/registry.tsx'
import { useHydraKeyboard } from '../keyboard/hydra.tsx'
import { afterTaskLayout, scrollTask } from './scroll-task.ts'

// Keep each tab's view across reloads and newly served builds.
type Restore = {
  selected?: string | null
  expanded?: string[]
  revealed?: {
    scope: string
    ids: string[]
  }
  page?: string
  panel?: boolean
  drafts?: Record<string, string>
  comments?: Record<string, ChatComment[]>
  scroll?: Record<string, [number, number]>
}

function restoreView({ key }: { key: string }): Restore {
  try {
    return JSON.parse(sessionStorage.getItem(key) ?? '{}') as Restore
  } catch {
    return {}
  }
}

const scrollers = () => [...document.querySelectorAll<HTMLElement>('.kanban, [data-column] > .column-cards')]
  .map(el => [
    el.closest('[data-column]')?.getAttribute('data-column') ?? 'kanban',
    el,
  ] as const)

const hydraViews = new Map<string, Restore>()

function expandedByColumn({
  ids,
  cards,
  pending,
}: {
  ids: string[]
  cards: Record<string, Card>
  pending: Record<string, string>
}) {
  const columns = new Set<string>(), kept: string[] = []

  for (const id of [...ids].reverse()) {
    const column = cards[id]?.column ?? pending[id] ?? id

    if (!columns.has(column)) {
      columns.add(column); kept.push(id)
    }
  }

  return kept.reverse()
}

export function App() {
  const hydra = useHydra()

  return <HydraView key={hydra.navigation.hydraId} hydra={hydra} />
}

function HydraView({ hydra }: { hydra: ReturnType<typeof useHydra> }) {
  const {
    state,
    command,
    connected,
    hydraThread,
    latest,
    navigation,
    navigate,
    loading,
    loaded,
    error,
  } = hydra
  const restoreKey = useRef(storageKey({ key: 'restore' })).current
  const [restored] = useState(() => hydraViews.get(navigation.hydraId)
    ?? restoreView({ key: restoreKey }))
  const [
      page,
      setPage,
    ] = useState(new URLSearchParams(location.search).has('projects') || new URLSearchParams(location.search).has('open-project') ? 'hydra' : restored.page ?? 'hydra'), [
      workspace,
      setWorkspace,
    ] = useState(''), [
      tag,
      setTag,
    ] = useState(''), [
      query,
      setQuery,
    ] = useState('')
  const [
      selected,
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
    ids: expanded,
    cards: state.cards,
    pending: pendingColumns.current,
  })
  useEffect(
    () => {
      setExpanded(ids => {
        const next = expandedByColumn({
          ids,
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
    const id = pendingFocus.current

    if (page !== 'hydra' || !id) {
      return
    }

    const element = document.querySelector<HTMLElement>(`.card[data-task="${CSS.escape(id)}"].selected`)
    const updates = element?.querySelector<HTMLElement>('.task-updates')

    if (updates) {
      pendingFocus.current = null
      requestAnimationFrame(() => {
        updates.focus({ preventScroll: true })
      })
    }
  })
  const [
    comments,
    setComments,
  ] = useState<Record<string, ChatComment[]>>(restored.comments ?? {})
  const [
    creatingTask,
    setCreatingTask,
  ] = useState<{
    column: string
    parent?: string
  } | null>(null)
  const [
    historyQuery,
    setHistoryQuery,
  ] = useState('')
  const [
    addingProject,
    setAddingProject,
  ] = useState(new URLSearchParams(location.search).has('projects'))
  const [
    panel,
    setPanel,
  ] = useState(restored.panel ?? true)
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

      if (url.searchParams.has('projects')) {
        url.searchParams.delete('projects')
      }

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

  useEffect(
    () => {
      if (addingProject && state.config?.hydra.kind === 'firstmate') {
        setPage('settings'); setAddingProject(false)
      }
    },
    [
      addingProject,
      state.config?.hydra.kind,
    ],
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
  useEffect(
    () => {
      if (connected) {
        void command({
          name: 'hydras',
          args: [],
        }).catch((error: Error) => notify({ text: error.message }))
      }
    },
    [
      connected,
      command,
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
        comments,
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
        navigation.hydraId,
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
      navigation.hydraId,
      selected,
      expanded,
      revealed,
      page,
      panel,
      drafts,
      comments,
      restoreKey,
    ],
  )
  const pendingScroll = useRef(restored.scroll)
  const view = viewFor({ state })
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
  const found = useFoundCards({
    command,
    query: commandQuery({ query }) ? '' : query,
    workspace,
    revision: state.seq,
  })
  const filteredCards = findBoxCards({
    state,
    workspace,
    tag,
    query: commandQuery({ query }) ? '' : query,
    meaning: found.map(h => h.card),
  }).filter(c => !project || c.project === project || projectReferences.includes(c.project ?? ''))
  const filterScope = JSON.stringify([
    workspace,
    tag,
    query,
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
  const title = pageTitle({
    page,
    cards: state.cards,
    selected,
    needsYou: columns.find(c => c.role === 'needs_you')?.id,
  })
  useEffect(
    () => {
      document.title = title
    },
    [title],
  )
  const save = useCallback(
    ({ patch }: { patch: unknown }) => command({
      name: 'view',
      args: [
        'set',
        '--json',
        JSON.stringify(patch),
        '--if-revision',
        String(state.viewRevision ?? 0),
        '--event-id',
        crypto.randomUUID(),
      ],
    }).then(
      () => {
        return true
      },
      e => {
        notify({ text: e.message })

        return false
      },
    ),
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
              comments,
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
      comments,
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

  const open = async ({ id }: { id: string }): Promise<boolean> => {
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

      const updates = element.querySelector<HTMLElement>('.task-updates')
      updates?.focus({ preventScroll: true })

      return !!updates && element.isConnected && !signal.aborted
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
    setPage('hydra'); setWorkspace(''); setTag(''); setQuery(''); filterProject({ path: '' }); clearSelection()
    setCreatingTask({
      column,
      ...(parent ? { parent } : {}),
    })
    requestAnimationFrame(() => requestAnimationFrame(() => focusElement({ selector: '.task-create [aria-label="Task title"]' })))
  }

  const createColumn = () => {
    const id = `custom:${crypto.randomUUID()}`
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
    }).then(() => {
      setPage('hydra'); setNewColumn(id)
      requestAnimationFrame(() => requestAnimationFrame(() => focusElement({ selector: `[data-column="${CSS.escape(id)}"] input` })))
    })
      .catch(e => notify({ text: e.message }))
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
    showPanel: () => setPanel(true),
  })

  const answerTask = ({ card }: { card: Card }) => {
    setPanel(true)
    setDrafts(drafts => ({
      ...drafts,
      [HYDRA_CARD]: `${drafts[HYDRA_CARD] || ''}\nFor @${card.id} (${card.title}): `.trimStart(),
    }))
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.hydra-chat textarea')?.focus())
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
          state={state}
          openTask={open}
          shown={panel}
          connected={connected}
          page={page}
          navigate={({ page }) => setPage(page)}
          oracle={(
            <Oracle
              selected={selected}
              page={page}
              state={state}
              view={view}
              command={command}
              query={query}
              setQuery={({ query }) => setQuery(query)}
              hits={found}
              save={save}
              openTask={open}
              openHydra={openHydra}
              history={() => {
                setHistoryQuery(query); setPage('history')
              }}
              showPanel={() => setPanel(true)}
              createTask={createTask}
              createColumn={createColumn}
              action={keyboard.onAction}
              notify={notify}
              connected={connected}
            />
          )}
        >
          <Hydras
            command={command}
            connected={connected}
            notify={notify}
            hydras={navigation.hydras}
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
            addProject={() => {
              setPage(state.config?.hydra.kind === 'firstmate' ? 'settings' : 'hydra'); setAddingProject(true)
            }}
          />
        </Panel>
        <main className="shell" aria-busy={!!loading || !loaded}>
          {(loading || !loaded) && <p className="loading-status" role="status">Loading {loading ? navigation.hydras.find(h => h.id === loading)?.name ?? 'Hydra' : 'Hydra'}…</p>}
          {error && <p className="error-banner" role="alert">{error}</p>}
          {page === 'settings' ? (
            <Settings
              state={state}
              connected={connected}
              view={view}
              save={save}
              close={() => setPage('hydra')}
              command={command}
              notify={notify}
            />
          ) : page === 'history' ? (
            <History
              command={command}
              workspace={workspace}
              query={historyQuery}
              setQuery={({ query }) => setHistoryQuery(query)}
              open={open}
              notify={notify}
            />
          ) : (
            <>
              <div className="hydra-page">
                <HydraChat
                  projectSetup={state.config?.hydra.kind !== 'firstmate' && (addingProject || (connected && !(state.projects ?? []).some(p => !p.detached))) ? (
                    <AddProject
                      autoFocus={addingProject}
                      command={command}
                      connected={connected}
                      notify={notify}
                      attached={() => setAddingProject(false)}
                      cancel={addingProject ? () => setAddingProject(false) : undefined}
                    />
                  ) : undefined}
                  state={state}
                  liveThread={hydraThread}
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
                                  saved={({ id }) => {
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
                                  key={item.id}
                                  card={item}
                                  labelColors={state.labelColors}
                                  doneAfterHours={state.config?.doneAfterHours}
                                  notify={notify}
                                  latest={latest[item.id]}
                                  answer={answerTask}
                                  selected={expandedIds.includes(item.id)}
                                  view={view}
                                  save={save}
                                  open={({ id }) => {
                                    if (expandedIds.includes(id)) {
                                      close({ id })
                                    } else {
                                      open({ id })
                                    }
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
                                      notify={notify}
                                      answer={answerTask}
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
              </div>
            </>
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

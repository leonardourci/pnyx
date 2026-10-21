import { Icon } from '../components/ui/icon.tsx'
import { storageKey } from './outbox.ts'
import { HYDRA_CARD, lockedColumn } from '../../../src/core/hydra.ts'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { viewFor } from '../../../src/core/view.ts'
import { Button } from '../components/ui/controls.tsx'
import { AddProject } from './add-project.tsx'
import { HydraChat } from './hydra-chat.tsx'
import { useHydra } from './connection.ts'
import { HydraCard } from './card.tsx'
import { TaskCreate } from './task-create.tsx'
import { Column } from './column.tsx'
import { Detail } from './detail.tsx'
import { TaskConversation } from './task-conversation.tsx'
import { sendableComment, type ChatComment } from './chat.ts'
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

// What a reload (by hand, or after the server serves a new build) would otherwise lose:
// the open card, the page, unsent drafts and how far the Hydra was scrolled. Kept per tab.
type Restore = {
  selected?: string | null
  page?: string
  panel?: boolean
  drafts?: Record<string, string>
  scroll?: Record<string, [number, number]>
}

// Comment drafts outlive the tab: a reload or a new tab finds them where they were left.
function readComments({ value }: { value: string | null }): Record<string, ChatComment[]> {
  try {
    const saved = JSON.parse(value ?? '{}') as Record<string, ChatComment[]>

    // An empty note was only kept for a return that a reload ends.
    return Object.fromEntries(Object.entries(saved).map(([
      card,
      items,
    ]) => [
      card,
      items.filter(comment => sendableComment({ comment })),
    ]))
  } catch {
    return {}
  }
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

export function App() {
  const hydra = useHydra()

  return <HydraView key={hydra.navigation.hydraId} hydra={hydra} />
}

function HydraView({ hydra }: { hydra: ReturnType<typeof useHydra> }) {
  const {
    state,
    command,
    connected,
    thread,
    hydraThread,
    latest,
    navigation,
    navigate,
    loading,
    loaded,
    error,
  } = hydra
  const restoreKey = useRef(storageKey({ key: 'restore' })).current
  const commentsKey = storageKey({
    key: 'comments',
    hydraId: navigation.hydraId,
  })
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
      setSelected,
    ] = useState<string | null>(new URLSearchParams(location.search).has('open-project') ? null : restored.selected ?? null), [
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
    comments,
    setComments,
  ] = useState(() => readComments({ value: localStorage.getItem(commentsKey) }))
  // Another tab's edits arrive here, so the next write from this tab doesn't undo them.
  useEffect(
    () => {
      const sync = ({
        key,
        newValue,
      }: StorageEvent) => {
        if (key === commentsKey && newValue !== JSON.stringify(comments)) {
          setComments(readComments({ value: newValue }))
        }
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
          JSON.stringify(comments),
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
      page,
      panel,
      drafts,
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
  const card = selected ? state.cards[selected] : undefined
  const cards = card && !filteredCards.some(item => item.id === card.id)
    ? [
      ...filteredCards,
      card,
    ] : filteredCards
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
            el.scrollTo(...(scroll[key] ?? [
              0,
              0,
            ]))
          }
        })
      }
    },
    [state.seq],
  )
  useEffect(
    () => {
      if (page === 'hydra' && selected) {
        requestAnimationFrame(() => document.querySelector('.card.selected')?.scrollIntoView({
          block: 'nearest',
          inline: 'nearest',
        }))
      }
    },
    [
      page,
      selected,
    ],
  )

  const openHydra = () => {
    setPage('hydra')
    requestAnimationFrame(() => focusElement({ selector: '.hydra-chat textarea' }))
  }

  const open = ({ id }: { id: string }) => {
    if (id === '$board') {
      openHydra()

      return
    }

    if (state.cards[id]) {
      setSelected(id); setPage('hydra')
      requestAnimationFrame(() => requestAnimationFrame(() => focusElement({ selector: '.task-updates' })))
    }
  }

  const close = () => {
    const target = filteredCards.find(c => c.id === selected) ?? filteredCards.find(c => c.column === card?.column) ?? filteredCards[0]; setSelected(null); requestAnimationFrame(() => focusElement({ selector: target ? `[data-card="${CSS.escape(target.id)}"]` : `[data-column-heading="${CSS.escape(card?.column ?? 'needs_you')}"]` }))
  }

  const createTask = ({
    column,
    parent,
  }: {
    column: string
    parent?: string
  }) => {
    setPage('hydra'); setWorkspace(''); setTag(''); setQuery(''); filterProject({ path: '' }); setSelected(null)
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
  const detail = card && (
    <Detail
      key={card.id}
      card={card}
      state={state}
      command={command}
      connected={connected}
      close={close}
      createTask={createTask}
      notify={notify}
      conversation={card.agent ? (
        <TaskConversation
          card={card}
          liveThread={thread}
          cards={Object.values(state.cards)}
          openTask={open}
          title={card.title}
          draft={drafts[card.id] ?? ''}
          setDraft={({ text }) => setDrafts(d => ({
            ...d,
            [card.id]: text,
          }))}
          comments={comments[card.id] ?? []}
          setComments={({ items }) => setComments(c => ({
            ...c,
            [card.id]: items,
          }))}
          height={view.composerHeight}
          command={command}
          save={save}
          connected={connected}
          notify={notify}
        />
      ) : undefined}
    />
  )

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
              filterProject({ path: project === path ? '' : path }); setSelected(null); setPage('hydra')
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
                  openTask={open}
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
                                    setCreatingTask(null); setSelected(id)
                                    requestAnimationFrame(() => requestAnimationFrame(() => focusElement({ selector: '.task-updates' })))
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
                                  state={state}
                                  firstmate={state.config?.hydra.kind === 'firstmate'}
                                  labelColors={state.labelColors}
                                  doneAfterHours={state.config?.doneAfterHours}
                                  notify={notify}
                                  latest={latest[item.id]}
                                  selected={selected === item.id}
                                  view={view}
                                  save={save}
                                  open={({ id }) => selected === id ? close() : open({ id })}
                                  command={command}
                                  connected={connected}
                                  tabIndex={
                                    (items.some(i => i.id === keyboard.remembered[c.id])
                                      ? keyboard.remembered[c.id]
                                      : items[0]?.id) === item.id ? 0 : -1
                                  }
                                >
                                  {selected === item.id && detail}
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

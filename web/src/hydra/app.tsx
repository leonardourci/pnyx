import { storageKey } from './outbox.ts'
import { HYDRA_CARD, lockedColumn } from '../../../src/core/hydra.ts'
import { cardSessionId } from '../../../src/core/tasks.ts'
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { viewFor } from '../../../src/core/view.ts'
import type { ThreadPage } from '../../../src/thread/read.ts'
import { Button } from '../components/ui/controls.tsx'
import { AddProject } from './add-project.tsx'
import { HydraChat } from './hydra-chat.tsx'
import { useHydra } from './connection.ts'
import { HydraCard } from './card.tsx'
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

// What a reload (by hand, or after the server serves a new build) would otherwise lose:
// the open card, the page, unsent drafts and how far the Hydra was scrolled. Kept per tab.
const RESTORE_KEY = storageKey({ key: 'restore' })
type Restore = {
  selected?: string | null
  page?: string
  panel?: boolean
  drafts?: Record<string, string>
  comments?: Record<string, ChatComment[]>
  scroll?: Record<string, [number, number]>
}
const restored: Restore = (() => {
  try {
    const value = JSON.parse(sessionStorage.getItem(RESTORE_KEY) ?? '{}') as Restore
    sessionStorage.removeItem(RESTORE_KEY)

    return value
  } catch {
    return {}
  }
})()
const scrollers = () => [...document.querySelectorAll<HTMLElement>('.kanban, [data-column] > .column-cards')]
  .map(el => [el.closest('[data-column]')?.getAttribute('data-column') ?? 'kanban', el] as const)

export function App() {
  const {
    state, command, connected, thread, setThread, hydraThread, latest, navigation,
  } = useHydra()
  const [page, setPage] = useState(new URLSearchParams(location.search).has('projects') || new URLSearchParams(location.search).has('open-project') ? 'hydra' : restored.page ?? 'hydra'), [workspace, setWorkspace] = useState(''), [tag, setTag] = useState(''), [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(new URLSearchParams(location.search).has('open-project') ? null : restored.selected ?? null), [drafts, setDrafts] = useState<Record<string,string>>(restored.drafts ?? {}), [notice, setNotice] = useState(''), [newColumn, setNewColumn] = useState<string | null>(null)
  const [comments, setComments] = useState<Record<string, ChatComment[]>>(restored.comments ?? {})
  const [editingTask, setEditingTask] = useState<string | null>(null)
  const [historyQuery, setHistoryQuery] = useState('')
  const [addingProject, setAddingProject] = useState(new URLSearchParams(location.search).has('projects'))
  const [panel, setPanel] = useState(restored.panel ?? true)
  const [project, setProject] = useState(new URLSearchParams(location.search).get('open-project') ?? new URLSearchParams(location.search).get('project') ?? '')
  const [projectReferences, setProjectReferences] = useState<string[]>([])
  const resolveProject = useCallback(({ references }: { references: string[] }) => {
    setProjectReferences(references)
  }, [])
  useEffect(() => {
    const url = new URL(location.href)

    if (url.searchParams.has('projects')) {
      url.searchParams.delete('projects')
    }

    const project = url.searchParams.get('open-project')

    if (project !== null) {
      url.searchParams.delete('open-project'); url.searchParams.set('project', project)
    }

    history.replaceState(null, '', url)
  }, [])

  useEffect(() => {
    if (addingProject && state.config?.hydra.kind === 'firstmate') {
      setPage('settings'); setAddingProject(false)
    }
  }, [addingProject, state.config?.hydra.kind])

  const filterProject = ({ path }: { path: string }) => {
    setProject(path)
    const url = new URL(location.href)

    if (path) {
      url.searchParams.set('project', path)
    } else {
      url.searchParams.delete('project')
    }

    history.replaceState(null, '', url)
  }

  const notify = useCallback(({ text }: { text: string }) => {
    setNotice(text)
  }, [])
  useEffect(() => {
    if (connected) {
      void command({ name: 'hydras', args: [] }).catch((error: Error) => notify({ text: error.message }))
    }
  }, [connected, command, notify])
  useEffect(() => {
    const timers = new Map<HTMLElement, ReturnType<typeof setTimeout>>()

    const scroll = (event: Event) => {
      const target = event.target

      if (!(target instanceof HTMLElement)) {
        return
      }

      clearTimeout(timers.get(target)); target.classList.add('scrolling')
      timers.set(target, setTimeout(() => {
        target.classList.remove('scrolling'); timers.delete(target)
      }, 700))
    }

    document.addEventListener('scroll', scroll, true)

    return () => {
      document.removeEventListener('scroll', scroll, true); timers.forEach(timer => clearTimeout(timer))
    }
  }, [])
  const pendingScroll = useRef(restored.scroll)
  const view = viewFor({ state })
  useEffect(() => {
    const root = document.documentElement, dark = matchMedia('(prefers-color-scheme: dark)')

    const apply = () => {
      root.dataset.theme = view.theme === 'system' ? (dark.matches ? 'dark' : 'light') : view.theme
    }

    apply(); dark.addEventListener('change', apply)

    return () => dark.removeEventListener('change', apply)
  }, [view.theme])
  const columns = columnsFor({ state })
  const found = useFoundCards({ command, query: commandQuery({ query }) ? '' : query, workspace, revision: state.seq })
  const filteredCards = findBoxCards({
    state,
    workspace,
    tag,
    query: commandQuery({ query }) ? '' : query,
    meaning: found.map(h => h.card),
  }).filter(c => !project || c.project === project || projectReferences.includes(c.project ?? ''))
  const card = selected ? state.cards[selected] : undefined
  const cards = card && !filteredCards.some(item => item.id === card.id)
    ? [...filteredCards, card] : filteredCards
  const attachedSession = card ? cardSessionId({ card }) : undefined
  const title = pageTitle({ page, cards: state.cards, selected, needsYou: columns.find(c => c.role === 'needs_you')?.id })
  useEffect(() => {
    document.title = title
  }, [title])
  const save = useCallback(({ patch }: { patch: unknown }) => command({ name: 'view', args: ['set', '--json', JSON.stringify(patch), '--if-revision', String(state.viewRevision ?? 0), '--event-id', crypto.randomUUID()] }).then(() => {
    return true
  }, e => {
    notify({ text: e.message })

    return false
  }), [command, notify, state.viewRevision])
  useEffect(() => {
    if (!connected) {
      return
    }

    let cancelled = false; void command({ name: 'thread', args: [selected ?? ''] }).then(r => {
      if (!cancelled && r.thread) {
        setThread(r.thread as ThreadPage)
      }
    })
      .catch(e => {
        if (!cancelled) {
          notify({ text: e.message })
        }
      })

    return () => {
      cancelled = true
    }
  }, [selected, attachedSession, connected, command, setThread, notify])
  useEffect(() => {
    const keep = () => {
      try {
        const scroll = Object.fromEntries(scrollers()
          .map(([key, el]) => [key, [el.scrollLeft, el.scrollTop]]))
        sessionStorage.setItem(RESTORE_KEY, JSON.stringify({
          selected, page, panel, drafts, comments, scroll,
        }))
      } catch { /* Storage full or blocked: the reload starts fresh. */ }
    }

    addEventListener('pagehide', keep)

    return () => removeEventListener('pagehide', keep)
  }, [selected, page, panel, drafts, comments])
  useEffect(() => {
    const scroll = pendingScroll.current

    if (scroll && state.seq > 0) {
      pendingScroll.current = undefined
      requestAnimationFrame(() => {
        for (const [key, el] of scrollers()) {
          el.scrollTo(...(scroll[key] ?? [0, 0]))
        }
      })
    }
  }, [state.seq])
  useEffect(() => {
    if (page === 'hydra' && selected) {
      requestAnimationFrame(() => document.querySelector('.card.selected')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }))
    }
  }, [page, selected])

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
      requestAnimationFrame(() => requestAnimationFrame(() => focusElement({ selector: '.detail .composer textarea' })))
    }
  }

  const close = () => {
    const target = filteredCards.find(c => c.id === selected) ?? filteredCards.find(c => c.column === card?.column) ?? filteredCards[0]; setSelected(null); requestAnimationFrame(() => focusElement({ selector: target ? `[data-card="${CSS.escape(target.id)}"]` : `[data-column-heading="${CSS.escape(card?.column ?? 'needs_you')}"]` }))
  }

  const createTask = ({ column, parent }: { column: string; parent?: string }) => {
    void command({ name: 'task', args: ['create', '--title', parent ? 'New subtask' : 'New task', '--column', column, ...(parent ? ['--parent', parent] : []), '--event-id', crypto.randomUUID()] }).then(receipt => {
      setPage('hydra'); setWorkspace(''); setTag(''); setQuery(''); filterProject({ path: '' })
      const id = (receipt.card as { id: string }).id
      const first = cards.find(c => c.column === column)
      setEditingTask(id)

      if (first) {
        void command({ name: 'move', args: [id, column, '--before', first.id, '--event-id', crypto.randomUUID()] }).catch(e => notify({ text: e.message }))
      }
    })
      .catch(e => notify({ text: e.message }))
  }

  const createColumn = () => {
    const id = `custom:${crypto.randomUUID()}`
    void command({ name: 'column', args: ['create', '--id', id, '--title', 'New column', '--if-revision', String(state.configRevision ?? 0), '--event-id', crypto.randomUUID()] }).then(() => {
      setPage('hydra'); setNewColumn(id)
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
      key={`${card.id}:${attachedSession ?? ''}`}
      card={card}
      state={state}
      view={view}
      thread={thread?.session === attachedSession ? thread : null}
      command={command}
      connected={connected}
      close={close}
      save={save}
      draft={drafts[card.id] ?? ''}
      setDraft={({ text }) => setDrafts(d => ({ ...d, [card.id]: text }))}
      comments={comments[card.id] ?? []}
      setComments={({ items }) => setComments(c => ({ ...c, [card.id]: items }))}
      createTask={createTask}
      notify={notify}
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
        <main className="shell">
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
                  setDraft={({ text }) => setDrafts(d => ({ ...d, [HYDRA_CARD]: text }))}
                  comments={comments[HYDRA_CARD] ?? []}
                  setComments={({ items }) => setComments(c => ({ ...c, [HYDRA_CARD]: items }))}
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
                              locked={lockedColumn({ state, id: c.id })}
                              editingTitle={newColumn === c.id}
                              titleFinished={() => setNewColumn(null)}
                              createTask={createTask}
                            >
                              {items.map(item => (
                                <HydraCard
                                  key={item.id}
                                  card={item}
                                  doneAfterHours={state.config?.doneAfterHours}
                                  notify={notify}
                                  latest={latest[item.id]}
                                  selected={selected === item.id}
                                  view={view}
                                  open={({ id }) => selected === id ? close() : open({ id })}
                                  command={command}
                                  connected={connected}
                                  editingTitle={editingTask === item.id}
                                  titleFinished={() => setEditingTask(null)}
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
                          >+ Add column
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
        <span className="sr-only" role="status">{notice}</span>
      </div>
    </KeyboardProvider>
  )
}

import { HYDRA_CARD } from '../../../src/core/hydra.ts'
import { cardSessionId } from '../../../src/core/tasks.ts'
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { viewFor } from '../../../src/core/view.ts'
import type { ThreadPage } from '../../../src/thread/read.ts'
import { Button, Input } from '../components/ui/controls.tsx'
import { HydraChat } from './hydra-chat.tsx'
import { useBoard } from './connection.ts'
import { BoardCard } from './card.tsx'
import { Column } from './column.tsx'
import { Detail } from './detail.tsx'
import type { ChatComment } from './chat.ts'
import { Settings } from './settings.tsx'
import { BoardTabs } from './boards.tsx'
import { History } from './history.tsx'
import { columnsFor, findBoxCards, pageTitle } from './view.ts'
import { useFoundCards } from './card-search.ts'
import { KeyboardProvider, focusElement } from '../keyboard/registry.tsx'
import { useBoardKeyboard } from '../keyboard/board.tsx'

// What a reload (by hand, or after the server serves a new build) would otherwise lose:
// the open card, the page, unsent drafts and how far the board was scrolled. Kept per tab.
const RESTORE_KEY = 'pnyx-restore'
type Restore = {
  selected?: string | null
  page?: string
  topbar?: boolean
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
  const { state, command, connected, error, thread, setThread, hydraThread, latest } = useBoard()
  const [page, setPage] = useState(restored.page ?? 'board'), [workspace, setWorkspace] = useState(''), [tag, setTag] = useState(''), [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(restored.selected ?? null), [drafts, setDrafts] = useState<Record<string,string>>(restored.drafts ?? {}), [notice, setNotice] = useState(''), [newColumn, setNewColumn] = useState<string | null>(null)
  const [comments, setComments] = useState<Record<string, ChatComment[]>>(restored.comments ?? {})
  const [editingTask, setEditingTask] = useState<string | null>(null)
  const [topbar, setTopbar] = useState(restored.topbar ?? true)
  const notify = useCallback(({ text }: { text: string }) => {
    setNotice(text)
  }, [])
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
  const found = useFoundCards({ command, query, workspace })
  const filteredCards = findBoxCards({
    state,
    workspace,
    tag,
    query,
    meaning: found.map(h => h.card),
  })
  const card = selected ? state.cards[selected] : undefined
  const cards = card && !filteredCards.some(item => item.id === card.id)
    ? [...filteredCards, card] : filteredCards
  const attachedSession = card ? cardSessionId({ card }) : undefined
  const title = pageTitle({ page, cards: state.cards, selected })
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

    let cancelled = false; setThread(null); void command({ name: 'thread', args: [selected ?? ''] }).then(r => {
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
          selected, page, topbar, drafts, comments, scroll,
        }))
      } catch { /* Storage full or blocked: the reload starts fresh. */ }
    }

    addEventListener('pagehide', keep)

    return () => removeEventListener('pagehide', keep)
  }, [selected, page, topbar, drafts, comments])
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
    if (page === 'board' && selected) {
      requestAnimationFrame(() => document.querySelector('.card.selected')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }))
    }
  }, [page, selected])

  const open = ({ id }: { id: string }) => {
    if (state.cards[id]) {
      setSelected(id); setPage('board')
      requestAnimationFrame(() => requestAnimationFrame(() => focusElement({ selector: '.detail .composer textarea' })))
    }
  }

  const close = () => {
    const target = filteredCards.find(c => c.id === selected) ?? filteredCards.find(c => c.column === card?.column) ?? filteredCards[0]; setSelected(null); requestAnimationFrame(() => focusElement({ selector: target ? `[data-card="${CSS.escape(target.id)}"]` : `[data-column-heading="${CSS.escape(card?.column ?? 'needs_you')}"]` }))
  }

  const createTask = ({ column, parent }: { column: string; parent?: string }) => {
    void command({ name: 'task', args: ['create', '--title', parent ? 'New subtask' : 'New task', '--column', column, ...(parent ? ['--parent', parent] : []), '--event-id', crypto.randomUUID()] }).then(receipt => {
      setWorkspace(''); setTag(''); setQuery('')
      const id = (receipt.card as { id: string }).id
      const first = cards.find(c => c.column === column)
      setEditingTask(id)

      if (first) {
        void command({ name: 'move', args: [id, column, '--before', first.id, '--event-id', crypto.randomUUID()] }).catch(e => notify({ text: e.message }))
      }
    })
      .catch(e => notify({ text: e.message }))
  }

  const keyboard = useBoardKeyboard({
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
    toggleTopbar: () => setTopbar(shown => !shown),
    showTopbar: () => setTopbar(true),
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
        style={{
          '--text-ui': `${view.fontSize}px`,
          '--text-chat': `${view.chatFontSize}px`,
          '--text-code': `${view.codeFontSize}px`,
        } as CSSProperties}
      >
        <header className="topbar" hidden={!topbar}>
          <div className="brand">
            <span className="mark">π</span>
            <span>pnyx</span>
          </div>
          <nav aria-label="Main pages">
            <BoardTabs
              command={command}
              connected={connected}
              notify={notify}
              active={page === 'board'}
              showBoard={() => setPage('board')}
            />
            {[['history', 'History'], ['settings', 'Settings']].map(([id,label]) => (
              <Button key={id} aria-pressed={page === id} onClick={() => setPage(id)}>
                {label}
              </Button>
            ))}
          </nav>
          <div className="topbar-search" data-search-slot>
            <Input
              aria-label="Find a card"
              type="search"
              placeholder="Search…  ⌘K"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Escape') {
                  setQuery(''); e.currentTarget.blur()
                }
              }}
            />
          </div>
          {!connected && (
            <span
              className="connection"
              role="status"
              aria-label="Offline"
              title={error ?? 'Reconnecting'}
            ><i />
            </span>
          )}
        </header>
        <main className="shell">
          {page === 'settings' ? (
            <Settings
              state={state}
              view={view}
              save={save}
              close={() => setPage('board')}
              command={command}
              notify={notify}
            />
          ) : page === 'history' ? (
            <History
              command={command}
              workspace={workspace}
              open={open}
              notify={notify}
            />
          ) : (
            <>
              <div className="board-page">
                <HydraChat
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
                <div className="board-main">
                  <div className="work-area inline">
                    <div className="board-space">
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
                              revision={state.boardRevision ?? 0}
                              connected={connected}
                              columnIds={columns.map(c => c.id)}
                              editingTitle={newColumn === c.id}
                              titleFinished={() => setNewColumn(null)}
                              createTask={createTask}
                            >
                              {items.map(item => (
                                <BoardCard
                                  key={item.id}
                                  card={item}
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
                                </BoardCard>
                              ))}
                            </Column>
                          )
                        })}
                        <div className="add-column">
                          <Button
                            disabled={!connected}
                            onClick={() => {
                              const id = `custom:${crypto.randomUUID()}`
                              void command({ name: 'column', args: ['create', '--id', id, '--title', 'New column', '--event-id', crypto.randomUUID()] }).then(() => setNewColumn(id))
                                .catch(e => notify({ text: e.message }))
                            }}
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

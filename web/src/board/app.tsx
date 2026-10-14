import { Fragment, useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { Card, ViewPreferences } from '../../../src/core/model.ts'
import { VIEW_SIZE_LIMITS } from '../../../src/core/view.ts'
import { viewFor } from '../../../src/core/view.ts'
import type { ThreadPage } from '../../../src/thread/read.ts'
import { Button, Input, Select } from '../components/ui/controls.tsx'
import { Icon } from '../components/ui/icon.tsx'
import { InlineConfirm } from '../components/ui/inline-confirm.tsx'
import { Resize } from '../components/ui/resize.tsx'
import { useBoard } from './connection.ts'
import { BoardCard } from './card.tsx'
import { Detail } from './detail.tsx'
import type { ChatComment } from './chat.ts'
import { Settings } from './settings.tsx'
import { History } from './history.tsx'
import { columnsFor, findBoxCards, pageTitle } from './view.ts'
import { useFoundCards } from './card-search.ts'
import { KeyboardProvider, focusElement } from '../keyboard/registry.tsx'
import { KeyboardFooter, KeyboardLayers, KeyboardToolbar, useBoardKeyboard } from '../keyboard/board.tsx'

// What a reload (by hand, or after the server serves a new build) would otherwise lose:
// the open card, the page, unsent drafts and how far the board was scrolled. Kept per tab.
const RESTORE_KEY = 'pnyx-restore'
type Restore = {
  selected?: string | null
  page?: string
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

function Column({
  id,
  title,
  description,
  cards,
  view,
  save,
  remove,
  connected,
  children,
}: {
  id: string
  title: string
  description: string
  cards: Card[]
  view: ViewPreferences
  save({ patch }: { patch: unknown }): Promise<boolean>
  remove(): Promise<boolean>
  connected: boolean
  children: ReactNode
}) {
  const [width, setWidth] = useState<number | null>(null)

  return (
    <section
      data-column={id}
      className={`column column-${id}`}
      aria-label={title}
      style={{
        width: width ?? view.columnWidths[id] ?? 290,
        flexBasis: width ?? view.columnWidths[id] ?? 290,
        minWidth: VIEW_SIZE_LIMITS.columnWidth.min,
        minHeight: VIEW_SIZE_LIMITS.columnHeight.min,
      }}
    >
      <header className="column-header">
        <div className="row between">
          <h2>
            <Icon name={id} size={15} />
            {title}
          </h2>
          <span className="count">{String(cards.length).padStart(2,'0')}</span>
        </div>
        <p>{description}</p>
        {id.startsWith('custom:') && (
          <InlineConfirm
            label={`Delete ${title} column`}
            action="Delete column"
            message={`Delete “${title}”? Its cards return to automatic placement. You can undo this.`}
            disabled={!connected}
            confirm={remove}
          />
        )}
      </header>
      <div className="column-cards">
        {children}
        {cards.length === 0 && (
          <p
            className="empty"
            data-empty-column={id}
            data-key-scope="board"
            aria-label={`${title}: no cards`}
            tabIndex={0}
          >
            No cards here
          </p>
        )}
      </div>
      <Resize
        label={`Resize ${title} column`}
        value={view.columnWidths[id] ?? 290}
        min={VIEW_SIZE_LIMITS.columnWidth.min}
        max={VIEW_SIZE_LIMITS.columnWidth.max}
        onPreview={({ value }) => setWidth(value)}
        onCommit={({ value: n }) => save({ patch: { columnWidths: { [id]: n } } })}
      />
    </section>
  )
}

export function App() {
  const { state, command, connected, error, thread, setThread, latest } = useBoard()
  const [page, setPage] = useState(restored.page ?? 'board'), [workspace, setWorkspace] = useState(''), [tag, setTag] = useState(''), [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(restored.selected ?? null), [drafts, setDrafts] = useState<Record<string,string>>(restored.drafts ?? {}), [notice, setNotice] = useState(''), [newColumn, setNewColumn] = useState<string | null>(null)
  const [comments, setComments] = useState<Record<string, ChatComment[]>>(restored.comments ?? {})
  // The deletion a notice can undo; any later notice replaces it.
  const [undoColumn, setUndoColumn] = useState<string | null>(null)
  const notify = useCallback(({ text }: { text: string }) => {
    setNotice(text); setUndoColumn(null)
  }, [])
  const pendingScroll = useRef(restored.scroll)
  const view = viewFor({ state })
  useEffect(() => {
    // System follows the operating system and switches live with it.
    const root = document.documentElement, dark = matchMedia('(prefers-color-scheme: dark)')

    const apply = () => {
      root.dataset.theme = view.theme === 'system' ? (dark.matches ? 'dark' : 'light') : view.theme
    }

    apply(); dark.addEventListener('change', apply)

    return () => dark.removeEventListener('change', apply)
  }, [view.theme])
  const columns = columnsFor({ state })
  const found = useFoundCards({ command, query, workspace })
  const matches = new Map(found.map(h => [h.card, h]))
  const cards = findBoxCards({ state, workspace, tag, query, meaning: found.map(h => h.card) })
  const card = selected ? state.cards[selected] : undefined
  const title = pageTitle({ page, cards: state.cards, selected })
  useEffect(() => {
    document.title = title
  }, [title])
  const workspaces = [...new Set(Object.values(state.cards).map(c => c.workspace))].sort()
  const tags = [...new Set(Object.values(state.cards).flatMap(c => c.tags))].sort()
  const save = useCallback(({ patch }: { patch: unknown }) => command({ name: 'view', args: ['set', '--json', JSON.stringify(patch), '--if-revision', String(state.viewRevision ?? 0), '--event-id', crypto.randomUUID()] }).then(() => {
    notify({ text: 'Preferences saved' })

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
  }, [selected, connected, command, setThread, notify])
  useEffect(() => {
    const keep = () => {
      try {
        const scroll = Object.fromEntries(scrollers()
          .map(([key, el]) => [key, [el.scrollLeft, el.scrollTop]]))
        sessionStorage.setItem(RESTORE_KEY, JSON.stringify({
          selected, page, drafts, comments, scroll,
        }))
      } catch { /* Storage full or blocked: the reload starts fresh. */ }
    }

    addEventListener('pagehide', keep)

    return () => removeEventListener('pagehide', keep)
  }, [selected, page, drafts, comments])
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
    if (page === 'board' && selected && view.panelPlacement === 'inline') {
      requestAnimationFrame(() => document.querySelector('.column-cards > .detail')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }))
    }
  }, [page, selected, view.panelPlacement])

  const open = ({ id }: { id: string }) => {
    if (state.cards[id]) {
      // The conversation opens at its reply input, the end of the thread.
      setSelected(id); setPage('board')
      requestAnimationFrame(() => requestAnimationFrame(() => focusElement('.composer textarea')))
    }
  }

  const close = () => {
    const target = cards.find(c => c.id === selected) ?? cards.find(c => c.column === card?.column) ?? cards[0]; setSelected(null); requestAnimationFrame(() => focusElement({ selector: target ? `[data-card="${CSS.escape(target.id)}"]` : `[data-empty-column="${CSS.escape(card?.column ?? 'needs_you')}"]` }))
  }

  const removeColumn = async ({ id }: { id: string }) => {
    const eventId = crypto.randomUUID()

    try {
      await command({ name: 'view', args: ['set', '--json', JSON.stringify({ customColumns: view.customColumns.filter(c => c.id !== id) }), '--if-revision', String(state.viewRevision ?? 0), '--event-id', eventId] })
      notify({ text: 'Column deleted. Its cards returned to automatic placement.' }); setUndoColumn(eventId)
      requestAnimationFrame(() => focusElement({ selector: '[data-card], [data-empty-column]' }))

      return true
    } catch (e) {
      notify({ text: (e as Error).message })

      return false
    }
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
  })
  const detail = card && (
    <Detail
      key={card.id}
      card={card}
      state={state}
      view={view}
      thread={thread}
      command={command}
      connected={connected}
      close={close}
      save={save}
      draft={drafts[card.id] ?? ''}
      setDraft={({ text }) => setDrafts(d => ({ ...d, [card.id]: text }))}
      comments={comments[card.id] ?? []}
      setComments={({ items }) => setComments(c => ({ ...c, [card.id]: items }))}
      outside={!cards.some(c => c.id === card.id)}
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
        style={{
          '--text-ui': `${view.fontSize}px`,
          '--text-chat': `${view.chatFontSize}px`,
          '--text-code': `${view.codeFontSize}px`,
        } as CSSProperties}
      >
        <header className="topbar">
          <div className="brand">
            <span className="mark">π</span>
            <span>pnyx</span>
          </div>
          <nav aria-label="Main pages">
            {[['board', 'Board'], ['history', 'History'], ['settings', 'Settings']].map(([id,label]) => (
              <Button key={id} aria-pressed={page === id} onClick={() => setPage(id)}>
                <Icon name={id} size={14} />
                {label}
              </Button>
            ))}
          </nav>
          <KeyboardToolbar action={keyboard.onAction} />
          <span className={`connection ${connected ? 'online' : ''}`}>
            <i />
            {connected ? 'Connected' : 'Offline'}
          </span>
        </header>
        <main className="shell">
          {error && <div role="alert" className="error-banner">{error}</div>}
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
              <div className="hero">
                <div>
                  <span className="eyebrow">YOUR WORK, AT A GLANCE</span>
                  <h1>The working board</h1>
                  <p>Follow the work. Keep the conversation in view.</p>
                </div>
                <div className="hero-stats">
                  <strong>{Object.values(state.cards).filter(c => c.column === 'needs_you').length}</strong>
                  {' '}
                  need your attention
                  <p>
                    {Object.keys(state.cards).length}
                    {' '}
                    sessions ·
                    {' '}
                    {state.seq}
                    {' '}
                    recorded events
                  </p>
                </div>
              </div>
              <div className="toolbar">
                <div className="row wrap">
                  <Select
                    label="Workspace"
                    value={workspace}
                    options={[{ value: '', label: 'All workspaces' }, ...workspaces.map(w => ({ value: w, label: w }))]}
                    onChange={({ value }) => setWorkspace(value)}
                  />
                  <Select
                    label="Filter by tag"
                    value={tag}
                    options={[{ value: '', label: 'All tags' }, ...tags.map(t => ({ value: t, label: t }))]}
                    onChange={({ value }) => setTag(value)}
                  />
                  {(workspace || tag) && (
                    <Button
                      onClick={() => {
                        setWorkspace(''); setTag('')
                      }}
                    >
                      Clear filters
                    </Button>
                  )}
                </div>
                <div className="row">
                  <Icon name="search" />
                  <Input
                    aria-label="Find a card"
                    type="search"
                    placeholder="Find a card…"
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                  />
                </div>
              </div>
              <div className={`work-area ${view.panelPlacement}`}>
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
                          remove={() => removeColumn({ id: c.id })}
                          connected={connected}
                        >
                          {items.map(item => (
                            <Fragment key={item.id}>
                              <BoardCard
                                card={item}
                                latest={latest[item.id]}
                                match={matches.get(item.id)}
                                visible={cards}
                                selected={selected === item.id}
                                view={view}
                                open={open}
                                save={save}
                                tabIndex={
                                  (items.some(i => i.id === keyboard.remembered[c.id])
                                    ? keyboard.remembered[c.id]
                                    : items[0]?.id) === item.id ? 0 : -1
                                }
                              />
                              {selected === item.id && view.panelPlacement === 'inline' && detail}
                            </Fragment>
                          ))}
                        </Column>
                      )
                    })}
                    <div className="add-column">
                      {newColumn === null ? <Button onClick={() => setNewColumn('')} disabled={!connected}>+ Add column</Button> : (
                        <form
                          onSubmit={e => {
                            e.preventDefault()

                            if (!newColumn.trim()) {
                              return
                            }

                            const patch = { customColumns: [...view.customColumns, { id: `custom:${crypto.randomUUID()}`, title: newColumn.trim() }] }; void command({ name: 'view', args: ['set', '--json', JSON.stringify(patch), '--if-revision', String(state.viewRevision ?? 0), '--event-id', crypto.randomUUID()] }).then(() => setNewColumn(null))
                              .catch(e => notify({ text: e.message }))
                          }}
                        >
                          <Input
                            autoFocus
                            aria-label="New column name"
                            value={newColumn}
                            maxLength={60}
                            placeholder="Column name"
                            onChange={e => setNewColumn(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
                                setNewColumn(null)
                              }
                            }}
                          />
                          <div className="row">
                            <Button type="submit" variant="primary">Create column</Button>
                            <Button onClick={() => setNewColumn(null)}>Cancel</Button>
                          </div>
                        </form>
                      )}
                    </div>
                  </div>
                  <footer className="board-footer">
                    <span>
                      {cards.length}
                      {' '}
                      visible sessions
                    </span>
                    <KeyboardFooter />
                  </footer>
                </div>
                {(view.panelPlacement === 'right' || (card && !cards.some(c => c.id === card.id))) && detail}
              </div>
            </>
          )}
        </main>
        {notice && (
          <div role="status" className="notice">
            <span>{notice}</span>
            {undoColumn && (
              <Button
                onClick={() => {
                  void command({ name: 'undo', args: [undoColumn, '--if-revision', String(state.viewRevision ?? 0), '--event-id', crypto.randomUUID()] }).then(() => notify({ text: 'Column and its cards restored.' }))
                    .catch(e => notify({ text: e.message }))
                }}
              >
                Undo
              </Button>
            )}
            <Button aria-label="Dismiss notification" onClick={() => setNotice('')}>
              <Icon name="close" size={14} />
            </Button>
          </div>
        )}
        <KeyboardLayers keyboard={keyboard} state={state} connected={connected} />
      </div>
    </KeyboardProvider>
  )
}

import { useEffect, useRef, useState } from 'react'
import type { BoardState, Card, ViewPreferences } from '../../../src/core/model.ts'
import { VIEW_SIZE_LIMITS } from '../../../src/core/view.ts'
import type { ThreadEntry, ThreadPage } from '../../../src/thread/read.ts'
import { Button, Select, Switch } from '../components/ui/controls.tsx'
import { Icon } from '../components/ui/icon.tsx'
import { Resize } from '../components/ui/resize.tsx'
import { AgentControls, SettingChips, SettingList, harnessName } from './agent-settings.tsx'
import { Links, Tags } from './card.tsx'
import { Composer } from './composer.tsx'
import { ConversationBrief } from './notes.tsx'
import { columnsFor, receiptLabel } from './view.ts'
import type { Command } from './connection.ts'

const merge = (a: ThreadEntry[], b: ThreadEntry[]) => {
  const ids = new Set(b.map(e => e.id))

  return [...a.filter(e => !ids.has(e.id)), ...b]
}

export function Detail({
  card,
  state,
  view,
  thread,
  command,
  connected,
  close,
  save,
  draft,
  setDraft,
  outside,
  notify,
}: {
  card: Card
  state: BoardState
  view: ViewPreferences
  thread: ThreadPage | null
  command: Command
  connected: boolean
  close(): void
  save(patch: unknown): Promise<boolean>
  draft: string
  setDraft(text: string): void
  outside: boolean
  notify(text: string): void
}) {
  const [width, setWidth] = useState<number | null>(null), [tab, setTab] = useState('thread'), [older, setOlder] = useState<ThreadPage | null>(null), [kept, setKept] = useState<ThreadEntry[]>([]), [latest, setLatest] = useState(false)
  const scroller = useRef<HTMLDivElement>(null), atBottom = useRef(true)
  const [history, setHistory] = useState<{
    seq: number
    id: string
    at: string
    summary: string
  }[]>([])
  const overrides = view.cardTraceOverrides[card.id]
  const tools = overrides?.tools ?? view.toolDetails
  const thinking = overrides?.thinking ?? view.thinkingDetails
  const page = thread?.card === card.id ? thread : null
  const olderCursor = older ? older.older : page?.older
  useEffect(() => {
    if (page) {
      setKept(k => merge(k, page.entries))
    }
  }, [page])
  useEffect(() => {
    if (atBottom.current && scroller.current) {
      scroller.current.scrollTop = scroller.current.scrollHeight
    } else {
      setLatest(true)
    }
  }, [page])
  useEffect(() => {
    if (tab === 'history') {
      void command('history', ['--card', card.id, '--limit', '50']).then(r => setHistory(Array.isArray(r.events) ? r.events : []))
        .catch(e => notify(e.message))
    }
  }, [tab, card.id, card.revision, command, notify])

  const move = (to: string) => {
    void command('move', [card.id, ...(to === 'auto' ? ['--auto'] : [to]), '--if-revision', String(card.revision), '--event-id', crypto.randomUUID()]).then(() => notify('Placement updated. Source requests are unchanged.'))
      .catch(e => notify(e.message))
  }

  const entries = merge(kept, page?.entries ?? [])

  return (
    <aside
      aria-label={`Details for ${card.title}`}
      className={`detail ${view.panelPlacement}`}
      style={{
        width: width ?? view.panelWidth,
        flexBasis: width ?? view.panelWidth,
        minWidth: view.panelPlacement === 'right' ? VIEW_SIZE_LIMITS.panelWidth.min : 0,
        minHeight: view.panelPlacement === 'right' ? VIEW_SIZE_LIMITS.panelHeight.min : undefined,
      }}
    >
      {view.panelPlacement === 'right' && (
        <Resize
          label="Resize conversation panel"
          reverse
          value={view.panelWidth}
          min={VIEW_SIZE_LIMITS.panelWidth.min}
          max={VIEW_SIZE_LIMITS.panelWidth.max}
          onPreview={setWidth}
          onCommit={n => save({ panelWidth: n })}
        />
      )}
      <header className="detail-header">
        <div className="row between">
          <span className="eyebrow">
            {card.workspace}
            {' '}
            ·
            {' '}
            {card.agent ? harnessName(card.agent.provider) : 'Agent session'}
          </span>
          <Button aria-label="Close detail" onClick={close}>
            <Icon name="close" />
          </Button>
        </div>
        <h2>{card.title}</h2>
        <ConversationBrief
          card={card}
          entries={entries}
          command={command}
          notify={notify}
        />
        <Tags tags={card.tags} />
        <Links links={card.links} />
        <SettingChips settings={card.settings} />
        {outside && <p className="small gold">Outside current filters</p>}
        {card.attention.map(a => <p className="request" key={a.key}>{a.text ?? a.kind}</p>)}
      </header>
      <nav className="detail-tabs" aria-label="Card detail">
        {[['thread', 'Conversation'], ['agent', 'Agent'], ['history', 'History'], ['move', 'Why here / move']].map(([id,label]) => (
          <Button
            key={id}
            data-conversation-tab={id === 'thread' ? '' : undefined}
            aria-pressed={tab === id}
            onClick={() => setTab(id)}
          >
            {label}
          </Button>
        ))}
      </nav>
      {tab === 'thread' ? (
        <>
          <div className="thread-controls">
            <div className="row wrap">
              <Switch label="Tool details" checked={tools} onChange={tools => save({ cardTraceOverrides: { [card.id]: { tools } } })} />
              <Switch label="Thinking" checked={thinking} onChange={thinking => save({ cardTraceOverrides: { [card.id]: { thinking } } })} />
            </div>
            <div className="row between small muted">
              <span>{overrides ? 'This card has overrides' : 'Following board defaults'}</span>
              <Button
                disabled={!overrides}
                onClick={() => save({ cardTraceOverrides: { [card.id]: null } })}
              >
                Use defaults
              </Button>
            </div>
          </div>
          <div
            className="thread"
            data-key-scope="thread"
            role="region"
            aria-label="Agent conversation"
            tabIndex={0}
            ref={scroller}
            onScroll={e => {
              const el = e.currentTarget
              atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40

              if (atBottom.current) {
                setLatest(false)
              }
            }}
          >
            {olderCursor !== undefined && (
              <Button
                onClick={() => {
                  void command('thread', [card.id, String(olderCursor)]).then(r => {
                    const p = r.thread as ThreadPage; setOlder(p); setKept(k => merge(p.entries, k))
                  })
                    .catch(e => notify(e.message))
                }}
              >
                Load older messages
              </Button>
            )}
            {page?.unavailable && <p className="empty">{page.unavailable}</p>}
            {!page && <p className="empty">{connected ? 'Loading conversation…' : 'Reconnect to load conversation.'}</p>}
            {entries.map(e => {
              const expanded = e.kind === 'message' || (e.kind === 'tool' ? tools : thinking)

              return (
                <article key={e.id} className={`message ${e.kind}`}>
                  <div className="message-head">
                    <strong>
                      <Icon name={e.kind === 'message' ? 'agent' : e.kind} size={14} />
                      {e.role === 'assistant' ? 'Agent' : e.role === 'user' ? 'You' : e.role}
                    </strong>
                    <time>{e.at ? new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</time>
                    {!expanded && <Button onClick={() => save({ cardTraceOverrides: { [card.id]: { [e.kind === 'tool' ? 'tools' : 'thinking']: true } } })}>Show</Button>}
                  </div>
                  {expanded && <p>{e.text}</p>}
                  {e.receipt && <span className={`receipt receipt-${e.receipt}`}>{receiptLabel(e.receipt)}</span>}
                </article>
              )
            })}
            {page && entries.length === 0 && !page.unavailable && <p className="empty">No recorded messages yet.</p>}
          </div>
          {latest && (
            <Button
              className="jump"
              onClick={() => {
                if (scroller.current) {
                  scroller.current.scrollTop = scroller.current.scrollHeight
                }

                atBottom.current = true; setLatest(false)
              }}
            >
              Jump to latest ↓
            </Button>
          )}
          <div className="watch-banner">
            <strong>Not watching · presence unverified</strong>
            <p>
              The source has no listener signal. Activity alone does not confirm it is watching.
            </p>
          </div>
          <Composer
            card={card.id}
            title={card.title}
            draft={draft}
            setDraft={setDraft}
            thread={page}
            height={view.composerHeight}
            command={command}
            save={save}
            connected={connected}
            notify={notify}
          />
        </>
      ) : tab === 'agent' ? (
        <div className="detail-content">
          <SettingList settings={card.settings} />
          {!card.settings && <p className="empty">No settings reported yet. Claude Code and Codex report theirs as the session runs.</p>}
          <AgentControls
            card={card}
            thread={thread}
            command={command}
            connected={connected}
            notify={notify}
          />
        </div>
      ) : tab === 'history' ? (
        <div className="detail-content">
          {history.length ? history.map(e => (
            <article key={e.id} className="history-entry">
              <span className="eyebrow">
                Event
                {' '}
                {e.seq}
              </span>
              <p>{e.summary}</p>
              <time className="small muted">{new Date(e.at).toLocaleString()}</time>
            </article>
          )) : <p className="empty">No recorded history.</p>}
        </div>
      ) : (
        <div className="detail-content">
          <h3>Placement</h3>
          <p className="muted">{card.manualColumn ? 'Pinned manually. Return to auto to follow source facts.' : card.attention.some(a => a.blocking) ? 'A blocking source request needs your attention.' : card.links.some(l => l.kind === 'github_pr' && l.state === 'open') ? 'An open linked pull request is ready for review.' : card.outcome || card.column === 'done' ? 'A confirmed outcome or merge is recorded.' : 'Placement follows the recorded source facts.'}</p>
          <Select
            label="Move card"
            value={card.manualColumn ?? 'auto'}
            options={[{ value: 'auto', label: 'Return to auto' }, ...columnsFor(state).map(c => ({ value: c.id, label: c.title }))]}
            onChange={move}
            disabled={!connected}
          />
          <p className="small muted">Moving to Done does not complete the task or resolve a source decision.</p>
          <Button
            onClick={() => {
              void command('history', ['--card', card.id, '--kind', 'moved', '--limit', '1']).then(async r => {
                const events = r.events as { id: string }[]

                if (!Array.isArray(events) || !events.length) {
                  return notify('No placement to undo.')
                }

                await command('undo', [events[0].id, '--if-revision', String(card.revision), '--event-id', crypto.randomUUID()]); notify('Placement undone.')
              })
                .catch(e => notify(e.message))
            }}
          >
            Undo last placement
          </Button>
          <Button onClick={() => save({ cardHeights: { [card.id]: null } })}>
            Use default card height
          </Button>
        </div>
      )}
    </aside>
  )
}

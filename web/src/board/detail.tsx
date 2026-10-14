import { useEffect, useState } from 'react'
import type { BoardState, Card, ViewPreferences } from '../../../src/core/model.ts'
import { VIEW_SIZE_LIMITS } from '../../../src/core/view.ts'
import type { ThreadEntry, ThreadPage } from '../../../src/thread/read.ts'
import { Button, Select } from '../components/ui/controls.tsx'
import { Icon } from '../components/ui/icon.tsx'
import { Resize } from '../components/ui/resize.tsx'
import { SettingChips, SettingList, harnessName } from './agent-settings.tsx'
import { Links, Tags } from './card.tsx'
import { ConversationBrief } from './notes.tsx'
import { columnsFor } from './view.ts'
import { merge, Thread } from './thread.tsx'
import type { ChatComment } from './chat.ts'
import type { Command } from './connection.ts'

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
  comments,
  setComments,
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
  comments: ChatComment[]
  setComments(comments: ChatComment[]): void
  outside: boolean
  notify(text: string): void
}) {
  const [width, setWidth] = useState<number | null>(null), [tab, setTab] = useState('thread')
  // Every loaded conversation entry, older pages included, so the brief skips notes any of them repeat.
  const [kept, setKept] = useState<ThreadEntry[]>([])
  const [history, setHistory] = useState<{
    seq: number
    id: string
    at: string
    summary: string
  }[]>([])
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
          entries={merge({ kept, page: thread?.card === card.id ? thread.entries : [] })}
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
        <Thread
          card={card}
          view={view}
          thread={thread}
          kept={kept}
          setKept={setKept}
          command={command}
          connected={connected}
          save={save}
          draft={draft}
          setDraft={setDraft}
          comments={comments}
          setComments={setComments}
          notify={notify}
        />
      ) : tab === 'agent' ? (
        <div className="detail-content">
          <SettingList settings={card.settings} />
          {!card.settings && <p className="empty">No settings reported yet. Claude Code and Codex report theirs as the session runs.</p>}
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

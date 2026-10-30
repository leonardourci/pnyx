import type { HydraState } from '#app/model.ts'
import type { CurrentAction } from '#hydra/calls.ts'
import { HYDRA_MARK } from '#hydra/hydra-names.ts'
import type { HydraProjectSummary } from '#app/server-hydras.ts'
import type { Hit, Kind } from '#oracle/index.ts'
import type { ViewPreferences } from '#preferences/model.ts'
import { statusLabel, currentState } from '#tasks/card-status.ts'
import type { Card } from '#tasks/model.ts'
import { liveTask } from '#tasks/select.ts'
import { Projects } from '#web-projects/projects.tsx'
import { AgentKinds } from '#web-workers/agent-kinds.tsx'
import type { DoneAfterHours } from '#settings/model.ts'
import type { UpgradeStatus } from '#upgrade/model.ts'
import type { Command } from '#web-app/connection.ts'
import { useKeyboard } from '#web-preferences/keyboard-registry.tsx'
import { projectTitle } from '#web-projects/view.ts'
import { changedIds, resetPatch } from '#web-settings/changed.ts'
import type { SettingsMatch } from '#web-settings/catalog.ts'
import { SETTING_ICONS, SettingControl, SettingPreview } from '#web-settings/settings-page.tsx'
import { Button } from '#web-shared/ui/controls.tsx'
import { Icon } from '#web-shared/ui/icon.tsx'
import { Label } from '#web-shared/ui/label.tsx'
import { markdownText } from '#web-hydra/markdown.tsx'
import { Highlight, SettingRow } from '#web-shared/ui/setting-row.tsx'
import { relativeTime } from '#web-tasks/brief.ts'
import { CardLinks } from '#web-tasks/card-links.tsx'
import { ColumnChip } from '#web-tasks/column-chip.tsx'
import { cardState, columnLook, columnsFor } from '#web-tasks/view.ts'
import type { AskTarget } from './ask.ts'
import { APPLIES, TYPE_LABELS, type Filter } from './filters.ts'
import { ACTION_ICONS, type OracleAction, type OraclePanel } from './oracle-catalog.ts'
import type { OracleResult } from './results.ts'

const SNIPPET_SOURCES: Record<Kind, string> = {
  event: 'Update',
  note: 'Note',
  transcript: 'Conversation',
}
const KIND_NAMES: Record<string, string> = {
  project: 'projects',
  task: 'tasks',
  conversation: 'conversations',
  setting: 'settings',
  panel: 'settings',
  action: 'actions',
}

function Snippets({
  hit,
  terms,
  now,
}: {
  hit?: Hit
  terms: string[]
  now: number
}) {
  if (!hit?.snippets.length) {
    return null
  }

  return (
    <section className="oracle-snippets" aria-label="Matches">
      <h3 className="eyebrow">Matches</h3>
      {hit.snippets.map((
        snippet,
        index,
      ) => (
        <p key={index} className="oracle-snippet">
          <span className="muted small">{SNIPPET_SOURCES[snippet.kind]} · {relativeTime({
            at: snippet.at,
            now,
          })}
          </span>
          <span><Highlight text={markdownText({ text: snippet.snippet })} terms={terms} /></span>
        </p>
      ))}
    </section>
  )
}

function ColumnOf({
  state,
  card,
}: {
  state: HydraState
  card: Card
}) {
  const column = columnsFor({ state }).find(item => item.id === card.column)

  if (!column) {
    return null
  }

  const look = columnLook({ column })

  return <ColumnChip icon={look.icon} tone={look.tone} label={column.title} />
}

function TaskPreview({
  card,
  hit,
  state,
  action,
  connected,
  terms,
  doneAfterHours,
  now,
}: {
  card: Card
  hit?: Hit
  state: HydraState
  action?: CurrentAction
  connected: boolean
  terms: string[]
  doneAfterHours?: DoneAfterHours
  now: number
}) {
  const status = cardState({
    card,
    hours: doneAfterHours,
    connected,
    state,
    action,
    now,
  })
  const said = currentState({ card })

  return (
    <>
      <div className="oracle-card">
        <div className="card-state">
          <span className={`agent-activity activity-${status.kind}`}><i aria-hidden="true" />{statusLabel({ status })}</span>
          <time className="card-since" dateTime={status.at || card.updatedAt}>{relativeTime({
            at: status.at || card.updatedAt,
            now,
          })}
          </time>
          {card.project && (
            <Label
              project
              label={card.project}
              text={projectTitle({ project: card.project })}
              colors={state.labelColors}
            />
          )}
        </div>
        <h3 className="oracle-card-title"><Highlight text={card.title} terms={terms} /></h3>
        <ColumnOf state={state} card={card} />
        {said && <p className="oracle-card-said"><Highlight text={markdownText({ text: said.text })} terms={terms} /></p>}
        <CardLinks links={card.links} expanded={false} />
      </div>
      <Snippets hit={hit} terms={terms} now={now} />
    </>
  )
}

function ProjectPreview({
  project,
  state,
}: {
  project: HydraProjectSummary
  state: HydraState
}) {
  const tasks = Object.values(state.cards)
    .filter(card => liveTask({ card }) && project.references.includes(card.project ?? ''))

  return (
    <>
      <h3 className="oracle-preview-title"><Icon name="project" size={16} />{project.name}</h3>
      <p className="muted small"><code>{project.path}</code></p>
      <section className="oracle-project-tasks" aria-label="Live tasks">
        <h3 className="eyebrow">{tasks.length === 1 ? '1 live task' : `${tasks.length} live tasks`}</h3>
        {tasks.map(card => (
          <p key={card.id} className="oracle-project-task">
            <span>{card.title}</span>
            <ColumnOf state={state} card={card} />
          </p>
        ))}
      </section>
    </>
  )
}

function ActionPreview({ action }: { action: OracleAction }) {
  const { label } = useKeyboard()
  const keys = action.run === 'key' ? label({ id: action.key }) : ''

  return (
    <>
      <h3 className="oracle-preview-title"><Icon name={ACTION_ICONS[action.run]} size={16} />{action.label}</h3>
      <p>{action.does}</p>
      {keys && <p className="muted small">Its shortcut: <kbd>{keys}</kbd></p>}
    </>
  )
}

const names = ({ kinds }: { kinds: string[] }) => [...new Set(kinds.map(kind => KIND_NAMES[kind]))].join(', ')

function filterReach({ filter }: { filter: Filter }) {
  if (filter.type === 'kind') {
    return `Keeps only ${names({ kinds: filter.values })}.`
  }

  if (filter.type === 'hydra') {
    return 'Keeps this Hydra’s results; settings and actions apply to every Hydra.'
  }

  return `Keeps only the ${names({ kinds: APPLIES[filter.type] })} it matches.`
}

export function FilterPreview({
  filter,
  badges,
}: {
  filter?: Filter
  badges: Filter[]
}) {
  if (!filter) {
    return <p className="muted">Type part of a filter’s name after &gt;.</p>
  }

  const same = badges.filter(badge => badge.type === filter.type)
  const either = same.length ? ` With ${same.map(badge => badge.label).join(', ')}, either one matches.` : ''

  return (
    <>
      <h3 className="oracle-preview-title">{TYPE_LABELS[filter.type]}: <span className="search-badge" data-kind={filter.type}><Icon name={filter.icon} size={14} />{filter.label}</span></h3>
      <p className="muted"><kbd>Space</kbd>, <kbd>Tab</kbd> or <kbd>Enter</kbd> makes it a badge.</p>
      <p className="muted">{filterReach({ filter })}{either}</p>
    </>
  )
}

export interface SettingProps {
  view: ViewPreferences
  save({ patch }: { patch: unknown }): Promise<boolean>
  command: Command
  notify({ text }: { text: string }): void
  upgrade?: UpgradeStatus
  startUpgrade(): void
}

function SettingResult({
  match,
  state,
  settings,
}: {
  match: SettingsMatch
  state: HydraState
  settings: SettingProps
}) {
  const { entry } = match

  return (
    <SettingRow
      icon={SETTING_ICONS[entry.id] ?? 'settings'}
      label={entry.label}
      description={entry.description}
      terms={match.terms}
      changed={changedIds({ view: settings.view }).has(entry.id)}
      reset={() => settings.save({
        patch: resetPatch({
          id: entry.id,
          view: settings.view,
        }),
      })}
      preview={(
        <SettingPreview
          entry={entry}
          state={state}
          view={settings.view}
          save={settings.save}
        />
      )}
    >
      <SettingControl
        entry={entry}
        state={state}
        {...settings}
      />
    </SettingRow>
  )
}

function PanelPreview({
  panel,
  state,
  connected,
  settings,
}: {
  panel: OraclePanel
  state: HydraState
  connected: boolean
  settings: SettingProps
}) {
  if (panel.panel === 'projects') {
    return (
      <Projects
        state={state}
        command={settings.command}
        connected={connected}
        notify={settings.notify}
      />
    )
  }

  return <AgentKinds state={state} command={settings.command} notify={settings.notify} />
}

const OPEN_LABELS: Record<OracleResult['kind'], string> = {
  task: 'Open task',
  conversation: 'Open chat',
  project: 'Show project',
  setting: 'Open in Settings',
  panel: 'Edit here',
  action: 'Run',
}
const hints = ({ mod }: { mod: string }): Record<OracleResult['kind'], string> => ({
  task: `↵ opens the task · ${mod}↵ opens it with Hydra’s reply composer`,
  conversation: '↵ opens the chat',
  project: '↵ shows the project’s tasks on the board',
  setting: `↵ flips a switch or moves to its control · ${mod}↵ opens it on the Settings page`,
  panel: '↵ moves into its controls',
  action: '↵ runs it',
})

export function ResultPreview({
  result,
  state,
  cardActions,
  terms,
  doneAfterHours,
  connected,
  settings,
  choose,
}: {
  result: OracleResult
  state: HydraState
  cardActions: Record<string, CurrentAction>
  terms: string[]
  doneAfterHours?: DoneAfterHours
  connected: boolean
  settings: SettingProps
  choose({ elsewhere }: { elsewhere: boolean }): void
}) {
  const { platform } = useKeyboard()
  const now = Date.now()
  const elsewhere = result.kind === 'setting'
  // A task's conversation opens its task, so it reads like one.
  const card = result.kind === 'conversation' ? result.card : undefined
  const shownKind = card ? 'task' : result.kind
  const hint = hints({ mod: platform === 'mac' ? '⌘' : 'Ctrl+' })[shownKind]

  return (
    <>
      {result.kind === 'task' && (
        <TaskPreview
          card={result.card}
          hit={result.hit}
          state={state}
          action={cardActions[result.card.id]}
          connected={connected}
          terms={terms}
          doneAfterHours={doneAfterHours}
          now={now}
        />
      )}
      {card && (
        <TaskPreview
          card={card}
          state={state}
          action={cardActions[card.id]}
          connected={connected}
          terms={terms}
          doneAfterHours={doneAfterHours}
          now={now}
        />
      )}
      {result.kind === 'conversation' && !card && (
        <>
          <h3 className="oracle-preview-title"><Icon name="comments" size={16} />{result.title}</h3>
          <Snippets hit={result.hit} terms={terms} now={now} />
        </>
      )}
      {result.kind === 'project' && <ProjectPreview project={result.summary} state={state} />}
      {result.kind === 'setting' && <SettingResult match={result.match} state={state} settings={settings} />}
      {result.kind === 'panel' && (
        <PanelPreview
          panel={result.panel}
          state={state}
          connected={connected}
          settings={settings}
        />
      )}
      {result.kind === 'action' && <ActionPreview action={result.action} />}
      <div className="oracle-preview-foot">
        <Button variant="surface" onClick={() => choose({ elsewhere })}>{OPEN_LABELS[shownKind]}</Button>
        <p className="muted small">{hint}. → or Tab moves here; ↑ ↓ move between its controls; ← or Esc goes back to the bar.</p>
      </div>
    </>
  )
}

const askHint = ({
  picking,
  targeted,
  mod,
}: {
  picking: boolean
  targeted: boolean
  mod: string
}) => {
  if (picking) {
    return `↑ ↓ pick the Hydra · ↵ sends · ${mod}↵ sends and opens its chat · Esc goes back to the request`
  }

  if (!targeted) {
    return '↵ picks the Hydra · Esc leaves Ask mode and keeps the text as a search'
  }

  return `↵ sends · ${mod}↵ sends and opens its chat · Esc leaves Ask mode and keeps the text as a search`
}

// The request exactly as Hydra will read it, with where it goes.
export function AskPreview({
  to,
  request,
  picking,
  sending,
  error,
}: {
  to?: AskTarget
  request: string
  picking: boolean
  sending: boolean
  error?: string
}) {
  const { platform } = useKeyboard()
  const hint = askHint({
    picking,
    targeted: !!to,
    mod: platform === 'mac' ? '⌘' : 'Ctrl+',
  })

  return (
    <>
      <h3 className="oracle-preview-title"><Icon name={to?.icon ?? HYDRA_MARK} size={16} />Request to {to?.name ?? 'a Hydra'}</h3>
      {request.trim()
        ? <p className="oracle-ask-message">{request.trim()}</p>
        : <p className="muted">Type what you want to ask.</p>}
      {error && <p className="oracle-ask-error" role="alert">{error}</p>}
      <p className="muted small" role="status">{sending ? 'Sending…' : hint}</p>
    </>
  )
}

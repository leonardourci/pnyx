import { SearchBadgeLabel } from '#web-shared/ui/search-bar.tsx'
import type { ReactNode } from 'react'
import { useState } from 'react'
import type { TitanState } from '#app/model.ts'
import type { CurrentAction } from '#titan/calls.ts'
import { TITAN_MARK } from '#titan/titan-names.ts'
import type { TitanProjectSummary } from '#app/server-titans.ts'
import type { Hit, Kind } from '#oracle/model.ts'
import type { ViewPreferences } from '#preferences/model.ts'
import { viewFor } from '#preferences/view.ts'
import { currentState } from '#tasks/card-status.ts'
import type { Card } from '#tasks/model.ts'
import { liveTask } from '#tasks/select.ts'
import { Projects } from '#web-projects/projects.tsx'
import { AgentKinds } from '#web-workers/agent-kinds.tsx'
import type { DoneAfterHours } from '#settings/model.ts'
import type { UpgradeStatus } from '#upgrade/model.ts'
import type { Command } from '#web-app/connection.ts'
import { changedIds, resetPatch } from '#web-settings/changed.ts'
import { SETTING_ICONS, type SettingsMatch } from '#web-settings/catalog.ts'
import { DEFAULT_SETTINGS } from '#settings/settings.ts'
import { useSharedSettings } from '#web-settings/shared-settings.ts'
import { useTitanDispatch } from '#web-workers/heads-dispatch.ts'
import { SETTING_PREVIEWS, SettingControl, SettingPreview } from '#web-settings/settings-page.tsx'
import { Button } from '#web-shared/ui/controls.tsx'
import { ICON_SIZE, Icon } from '#web-shared/icons.tsx'
import { markdownText } from '#web-titan/markdown-text.ts'
import { Highlight, SettingRow } from '#web-shared/ui/setting-row.tsx'
import { relativeTime } from '#web-tasks/brief.ts'
import { CardLinks } from '#web-tasks/card-links.tsx'
import { CardSummary } from '#web-tasks/card-summary.tsx'
import { CardContent } from '#web-tasks/card-shell.tsx'
import { taskRollup } from '#web-tasks/project-view.ts'
import { taskProjectGroup } from '#tasks/order.ts'
import { cardState } from '#web-tasks/view.ts'
import type { AskTarget } from './ask.ts'
import { APPLIES, TYPE_LABELS, type Filter } from './filters.ts'
import { ACTION_ICONS, type OracleAction, type OraclePanel } from './oracle-catalog.ts'
import type { OracleResult } from './results.ts'
import { snippetText } from './snippet-text.ts'

const SNIPPET_SOURCES: Record<Kind, string> = {
  event: 'Update',
  note: 'Note',
}
const KIND_NAMES: Record<string, string> = {
  project: 'projects',
  task: 'tasks',
  conversation: 'conversations',
  setting: 'settings',
  panel: 'settings',
  action: 'actions',
}

function PreviewTitle({ children }: { children: ReactNode }) {
  return <h3 className="oracle-preview-title flex flex-wrap items-center gap-2">{children}</h3>
}

function Snippets({
  hit,
  now,
}: {
  hit?: Hit
  now: number
}) {
  if (!hit?.snippets.length) {
    return null
  }

  return (
    <section className="oracle-snippets flex flex-col gap-1.5" aria-label="Matches">
      <h3 className="eyebrow">Matches</h3>
      {hit.snippets.map((
        snippet,
        index,
      ) => (
        <p key={index} className="oracle-snippet flex max-h-oracle-excerpt flex-col gap-0.5 overflow-hidden rounded-sm border-l-2 border-gold-line bg-background px-2 py-1.5 wrap-anywhere whitespace-pre-wrap">
          <span className="muted small">{SNIPPET_SOURCES[snippet.kind]} · {relativeTime({
            at: snippet.at,
            now,
          })}
          </span>
          <span>{snippetText({ snippet }).map((
            part,
            index,
          ) => part.matched ? <mark key={index}>{part.text}</mark> : part.text)}
          </span>
        </p>
      ))}
    </section>
  )
}

function TaskPreview({
  card,
  hit,
  state,
  action,
  actions,
  connected,
  terms,
  doneAfterHours,
  now,
}: {
  card: Card
  hit?: Hit
  state: TitanState
  action?: CurrentAction
  actions: Record<string, CurrentAction>
  connected: boolean
  terms: string[]
  doneAfterHours?: DoneAfterHours
  now: number
}) {
  const hasChildren = Object.values(state.cards).some(child => child.parentId === card.id)
  const isFamily = card.parentId || hasChildren
  const status = isFamily
    ? taskRollup({
      state,
      card,
      actions,
    }).status
    : cardState({
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
      <div className="oracle-card flex flex-col items-start gap-1.75 rounded-card border border-line bg-background px-3 py-2.5">
        <CardContent className="w-full">
          <CardSummary
            card={card}
            status={status}
            now={now}
            colors={state.labelColors}
            legacyProject={taskProjectGroup({
              state,
              card,
            }) === 'ideas'}
            heading={<h3 className="oracle-card-title font-semibold"><Highlight text={card.title} terms={terms} /></h3>}
          />
          {said && <p className="oracle-card-said line-clamp-4 text-muted"><Highlight text={markdownText({ text: said.text })} terms={terms} /></p>}
          <CardLinks links={card.links} expanded={false} />
        </CardContent>
      </div>
      <Snippets hit={hit} now={now} />
    </>
  )
}

function ProjectPreview({
  project,
  state,
}: {
  project: TitanProjectSummary
  state: TitanState
}) {
  const tasks = Object.values(state.cards)
    .filter(card => liveTask({ card }) && card.project === project.path)

  return (
    <>
      <PreviewTitle><Icon name="project" size={ICON_SIZE.control} />{project.name}</PreviewTitle>
      <p className="muted small"><code>{project.path}</code></p>
      <section className="oracle-project-tasks flex flex-col gap-1.5" aria-label="Live tasks">
        <h3 className="eyebrow">{tasks.length === 1 ? '1 live task' : `${tasks.length} live tasks`}</h3>
        {tasks.map(card => (
          <p key={card.id} className="oracle-project-task flex items-center justify-between gap-2">
            <span>{card.title}</span>
          </p>
        ))}
      </section>
    </>
  )
}

function ActionPreview({ action }: { action: OracleAction }) {
  return (
    <>
      <PreviewTitle>
        <Icon name={ACTION_ICONS[action.run]} size={ICON_SIZE.control} />{action.label}
      </PreviewTitle>
      <p>{action.does}</p>
    </>
  )
}

const names = ({ kinds }: { kinds: string[] }) => [...new Set(kinds.map(kind => KIND_NAMES[kind]))].join(', ')

function filterReach({ filter }: { filter: Filter }) {
  if (filter.type === 'kind') {
    return `Keeps only ${names({ kinds: filter.values })}.`
  }

  if (filter.type === 'titan') {
    return 'Keeps this Titan’s results; settings and actions apply to every Titan.'
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
      <PreviewTitle>
        {TYPE_LABELS[filter.type]}:
        <SearchBadgeLabel kind={filter.type}>
          <Icon name={filter.icon} size={ICON_SIZE.inline} />{filter.label}
        </SearchBadgeLabel>
      </PreviewTitle>
      <p className="muted"><kbd>Space</kbd>, <kbd>Tab</kbd> or <kbd>Enter</kbd> makes it a badge.</p>
      <p className="muted">{filterReach({ filter })}{either}</p>
    </>
  )
}

export interface SettingProps {
  view: ViewPreferences
  connected: boolean
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
  state: TitanState
  settings: SettingProps
}) {
  const { entry } = match
  const [
    live,
    setLive,
  ] = useState<Record<string, unknown>>({})
  const shared = useSharedSettings() ?? DEFAULT_SETTINGS
  const {
    effective,
    saveTitan,
    error: dispatchError,
  } = useTitanDispatch({ command: settings.command })
  const rule = effective?.dispatch.rules.titan?.candidates[0] ?? effective?.dispatch.default[0]
  const shownSettings = {
    ...shared,
    ...live,
  }
  const shownView = viewFor({
    state,
    settings: {
      ...settings.view,
      ...shownSettings,
    },
  })
  const slide = ({
    key,
    value,
  }: {
    key: string
    value?: unknown
  }) => setLive(current => {
    const rest = Object.fromEntries(Object.entries(current).filter(([name]) => name !== key))

    return value === undefined ? rest : {
      ...rest,
      [key]: value,
    }
  })

  return (
    <SettingRow
      icon={SETTING_ICONS[entry.id] ?? 'settings'}
      label={entry.label}
      description={entry.description}
      terms={match.terms}
      changed={changedIds({
        view: settings.view,
        settings: shared,
      }).has(entry.id)}
      reset={() => settings.save({
        patch: resetPatch({
          id: entry.id,
          view: settings.view,
          settings: shared,
        }),
      })}
      preview={SETTING_PREVIEWS.has(entry.id) && (
        <SettingPreview
          entry={entry}
          state={state}
          view={shownView}
          save={settings.save}
          settings={shownSettings}
          rule={rule}
        />
      )}
    >
      <SettingControl
        entry={entry}
        state={state}
        {...settings}
        slide={slide}
        settings={shared}
        rule={rule}
        saveTitan={saveTitan}
        dispatchError={dispatchError}
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
  state: TitanState
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
  state: TitanState
  cardActions: Record<string, CurrentAction>
  terms: string[]
  doneAfterHours?: DoneAfterHours
  connected: boolean
  settings: SettingProps
  choose({ elsewhere }: { elsewhere: boolean }): void
}) {
  const now = Date.now()
  const elsewhere = result.kind === 'setting'
  // A task's conversation opens its task, so it reads like one.
  const card = result.kind === 'conversation' ? result.card : undefined
  const shownKind = card ? 'task' : result.kind

  return (
    <>
      {result.kind === 'task' && (
        <TaskPreview
          card={result.card}
          hit={result.hit}
          state={state}
          action={cardActions[result.card.id]}
          actions={cardActions}
          connected={connected}
          terms={terms}
          doneAfterHours={doneAfterHours}
          now={now}
        />
      )}
      {result.kind === 'conversation' && result.card && (
        <TaskPreview
          card={result.card}
          hit={result.hit}
          state={state}
          action={cardActions[result.card.id]}
          actions={cardActions}
          connected={connected}
          terms={terms}
          doneAfterHours={doneAfterHours}
          now={now}
        />
      )}
      {result.kind === 'conversation' && !card && (
        <>
          <PreviewTitle><Icon name="comments" size={ICON_SIZE.control} />{result.title}</PreviewTitle>
          <Snippets hit={result.hit} now={now} />
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
      <div className="oracle-preview-foot mt-auto flex flex-col items-start gap-1.5 border-t border-subtle pt-2">
        <Button variant="surface" onClick={() => choose({ elsewhere })}>{OPEN_LABELS[shownKind]}</Button>
      </div>
    </>
  )
}

// The request exactly as Titan will read it, with where it goes.
export function AskPreview({
  to,
  request,
  sending,
  checking,
  error,
}: {
  to?: AskTarget
  request: string
  sending: boolean
  checking: boolean
  error?: string
}) {
  const progress = checking ? 'Checking…' : 'Sending…'

  return (
    <>
      <PreviewTitle><Icon name={to?.icon ?? TITAN_MARK} size={ICON_SIZE.control} />Request to {to?.name ?? 'a Titan'}</PreviewTitle>
      {request.trim() && <p className="oracle-ask-message m-0 rounded-lg border border-subtle bg-background px-3 py-2.5 wrap-anywhere whitespace-pre-wrap">{request.trim()}</p>}
      {error && <p className="oracle-ask-error text-red" role="alert">{error}</p>}
      {sending && <p className="muted small" role="status">{progress}</p>}
    </>
  )
}

import type { HydraState } from '#app/model.ts'
import type { HydraProjectSummary } from '#app/server-hydras.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import type { Hit } from '#oracle/index.ts'
import type { Card } from '#tasks/model.ts'
import { liveTask } from '#tasks/select.ts'
import { cardSessionId } from '#workers/session-attachments.ts'
import { searchSettings, SETTINGS_CATALOG, type SettingsMatch } from '#web-settings/catalog.ts'
import { nameMatches, passes, wholeList, type Candidate, type Filter, type FilterToken } from './filters.ts'
import { matchesCommand, oraclePanels, type OracleAction, type OraclePanel } from './oracle-catalog.ts'

interface Shown extends Candidate {
  id: string
  title: string
}

export type OracleResult = Shown & ({
  kind: 'task'
  card: Card
  hit?: Hit
} | {
  kind: 'conversation'
  hit?: Hit
  // A task's own conversation; without one, the result is the Hydra's chat.
  card?: Card
} | {
  kind: 'project'
  summary: HydraProjectSummary
} | {
  kind: 'setting'
  match: SettingsMatch
} | {
  kind: 'panel'
  panel: OraclePanel
} | {
  kind: 'action'
  action: OracleAction
})

export interface ResultGroup {
  label: string
  results: OracleResult[]
}

interface Hydra {
  id: string
  name: string
}

const taskResult = ({
  card,
  hit,
  hydra,
}: {
  card: Card
  hit?: Hit
  hydra: Hydra
}): OracleResult => ({
  id: `task:${card.id}`,
  kind: 'task',
  title: card.title,
  hydra: hydra.id,
  column: card.column,
  project: card.project,
  at: card.updatedAt,
  card,
  hit,
})

const newestSnippet = ({ hit }: { hit: Hit }) => hit.snippets.map(snippet => snippet.at).sort()
  .at(-1)

const conversationResult = ({
  hit,
  at,
  hydra,
}: {
  hit?: Hit
  at?: string
  hydra: Hydra
}): OracleResult => ({
  id: 'conversation:hydra',
  kind: 'conversation',
  title: `${hydra.name}’s chat`,
  hydra: hydra.id,
  at,
  hit,
})

const taskConversation = ({
  card,
  hydra,
}: {
  card: Card
  hydra: Hydra
}): OracleResult => ({
  id: `conversation:${card.id}`,
  kind: 'conversation',
  title: card.title,
  hydra: hydra.id,
  project: card.project,
  at: card.updatedAt,
  card,
})

const actionResult = ({ action }: { action: OracleAction }): OracleResult => ({
  id: action.id,
  kind: 'action',
  title: action.label,
  action,
})

const recentCards = ({ state }: { state: HydraState }) => Object.values(state.cards)
  .filter(card => card.id !== HYDRA_CARD && liveTask({ card }))
  .sort((
    a,
    b,
  ) => b.updatedAt.localeCompare(a.updatedAt))

const asksFor = ({
  badges,
  kind,
}: {
  badges: Filter[]
  kind: string
}) => badges.some(badge => badge.type === 'kind' && badge.values.includes(kind))

const settingResult = ({ match }: { match: SettingsMatch }): OracleResult => ({
  id: `setting:${match.entry.id}`,
  kind: 'setting',
  title: match.entry.label,
  match,
})

const panelResult = ({
  panel,
  hydra,
}: {
  panel: OraclePanel
  hydra: Hydra
}): OracleResult => ({
  id: panel.id,
  kind: 'panel',
  title: panel.label,
  hydra: hydra.id,
  panel,
})

// The actions and settings a bare > token names, listed beside the filter menu; long forms and text before the token name none.
export const menuActions = ({
  token,
  text,
  actions,
  state,
  hydra,
}: {
  token: FilterToken | null
  text: string
  actions: OracleAction[]
  state: HydraState
  hydra: Hydra
}): OracleResult[] => {
  if (!token || token.type || text) {
    return []
  }

  const named = ({ label }: { label: string }) => nameMatches({
    label,
    needle: token.needle,
  })

  return [
    ...actions.filter(named).map(action => actionResult({ action })),
    ...SETTINGS_CATALOG.filter(named).map(entry => settingResult({
      match: {
        entry,
        terms: [],
      },
    })),
    ...oraclePanels({ state }).filter(named)
      .map(panel => panelResult({
        panel,
        hydra,
      })),
  ]
}

// What the Oracle lists for a query and its badges, grouped: projects, tasks, conversations, then settings and actions.
export function oracleResults({
  state,
  hits,
  projects,
  actions,
  hydra,
  text,
  badges,
  now,
}: {
  state: HydraState
  hits: Hit[]
  projects: HydraProjectSummary[]
  actions: OracleAction[]
  hydra: Hydra
  text: string
  badges: Filter[]
  now: number
}): ResultGroup[] {
  const whole = wholeList({
    text,
    badges,
  })
  const words = text.toLowerCase().split(/\s+/)
    .filter(Boolean)
  // Without text, settings and actions fill the list only for the whole list or a Settings badge.
  const listsSettings = !!text || whole || asksFor({
    badges,
    kind: 'setting',
  })
  const visible = hits.filter(hit => hit.kind === 'hydra' || (state.cards[hit.card] && !state.cards[hit.card]!.hidden))
  const tasks = text
    ? visible.filter(hit => hit.kind !== 'hydra').map(hit => taskResult({
      card: state.cards[hit.card]!,
      hit,
      hydra,
    }))
    : recentCards({ state }).map(card => taskResult({
      card,
      hydra,
    }))
  const chat = visible.filter(hit => hit.kind === 'hydra').map(hit => conversationResult({
    hit,
    at: newestSnippet({ hit }),
    hydra,
  }))
  const ownChat = conversationResult({
    at: state.cards[HYDRA_CARD]?.updatedAt,
    hydra,
  })
  const taskChats = recentCards({ state }).filter(card => cardSessionId({ card }) !== undefined)
    .map(card => taskConversation({
      card,
      hydra,
    }))
  let conversations = chat

  if (whole) {
    conversations = [
      ownChat,
      ...taskChats,
    ]
  } else if (!text && asksFor({
    badges,
    kind: 'conversation',
  })) {
    conversations = [ownChat]
  }

  const projectResults = projects.filter(project => words.every(word => `${project.name} ${project.path}`.toLowerCase().includes(word)))
    .map((project): OracleResult => ({
      id: `project:${project.path}`,
      kind: 'project',
      title: project.name,
      hydra: hydra.id,
      project: project.path,
      summary: project,
    }))
  const settings = listsSettings
    ? searchSettings({ query: text }).map(match => settingResult({ match }))
    : []
  const panels = listsSettings ? oraclePanels({ state }).filter(panel => matchesCommand({
    query: text,
    text: `${panel.label} ${panel.words}`,
  }))
    .map(panel => panelResult({
      panel,
      hydra,
    })) : []
  const actionResults = listsSettings ? actions.filter(action => matchesCommand({
    query: text,
    text: `${action.label} ${action.words}`,
  }))
    .map(action => actionResult({ action })) : []
  const kept = ({ results }: { results: OracleResult[] }) => results.filter(item => passes({
    item,
    badges,
    now,
  }))

  return [
    {
      label: 'Projects',
      results: kept({ results: projectResults }),
    },
    {
      label: 'Tasks',
      results: kept({ results: tasks }),
    },
    {
      label: 'Conversations',
      results: kept({ results: conversations }),
    },
    {
      label: 'Settings and actions',
      results: kept({
        results: [
          ...settings,
          ...panels,
          ...actionResults,
        ],
      }),
    },
  ].filter(group => group.results.length > 0)
}

import { taskProjectGroup } from '#tasks/order.ts'
import { statusLabel } from '#tasks/card-status.ts'
import { taskRollup } from '#web-tasks/project-view.ts'
import { tokens } from '#oracle/query.ts'
import type { TitanState } from '#app/model.ts'
import type { TitanProjectSummary } from '#app/server-titans.ts'
import type { CurrentAction } from '#titan/calls.ts'
import { TITAN_CARD } from '#titan/identity.ts'
import type { Hit } from '#oracle/model.ts'
import type { Card } from '#tasks/model.ts'
import { liveTask } from '#tasks/select.ts'
import { searchSettings,SETTING_ICONS,SETTINGS_CATALOG,SETTINGS_SECTIONS,type SettingsMatch } from '#web-settings/catalog.ts'
import { relativeTime } from '#web-tasks/brief.ts'
import { filterCards } from '#web-tasks/view.ts'
import { cardSessionId } from '#workers/session-attachments.ts'
import { nameMatches,passes,TYPE_LABELS,type Candidate,type Filter,type FilterToken } from './filters.ts'
import { ACTION_ICONS,matchesCommand,oraclePanels,type OracleAction,type OraclePanel } from './oracle-catalog.ts'

interface Shown extends Candidate {
  id: string
  title: string
  titanName?: string
}

export type OracleResult = Shown & ({
  kind: 'task'
  card: Card
  hit?: Hit
} | {
  kind: 'conversation'
  hit?: Hit
  // A task's own conversation; without one, the result is the Titan's chat.
  card?: Card
} | {
  kind: 'project'
  summary: TitanProjectSummary
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

interface ResultGroup {
  label: string
  results: OracleResult[]
}

interface Titan {
  id: string
  name: string
}

const taskResult = ({
  state,
  card,
  hit,
  titan,
}: {
  state: TitanState
  card: Card
  hit?: Hit
  titan: Titan
}): OracleResult => ({
  id: `task:${card.id}`,
  kind: 'task',
  title: card.title,
  titan: titan.id,
  titanName: titan.name,
  column: taskProjectGroup({
    state,
    card,
  }),
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
  titan,
}: {
  hit?: Hit
  at?: string
  titan: Titan
}): OracleResult => ({
  id: 'conversation:titan',
  kind: 'conversation',
  title: `${titan.name}’s chat`,
  titan: titan.id,
  titanName: titan.name,
  at,
  hit,
})

const taskConversation = ({
  card,
  titan,
}: {
  card: Card
  titan: Titan
}): OracleResult => ({
  id: `conversation:${card.id}`,
  kind: 'conversation',
  title: card.title,
  titan: titan.id,
  titanName: titan.name,
  project: card.project,
  at: card.updatedAt,
  card,
})

const hasConversation = ({ card }: { card: Card }) => cardSessionId({ card }) !== undefined

const actionResult = ({ action }: { action: OracleAction }): OracleResult => ({
  id: action.id,
  kind: 'action',
  title: action.label,
  action,
})

const recentCards = ({ state }: { state: TitanState }) => Object.values(state.cards)
  .filter(card => card.id !== TITAN_CARD && liveTask({ card }))
  .sort((
    a,
    b,
  ) => b.updatedAt.localeCompare(a.updatedAt))

const settingResult = ({ match }: { match: SettingsMatch }): OracleResult => ({
  id: `setting:${match.entry.id}`,
  kind: 'setting',
  title: match.entry.label,
  match,
})

const panelResult = ({
  panel,
  titan,
}: {
  panel: OraclePanel
  titan: Titan
}): OracleResult => ({
  id: panel.id,
  kind: 'panel',
  title: panel.label,
  titan: titan.id,
  titanName: titan.name,
  panel,
})

// The actions and settings a bare > token names, listed beside the filter menu; long forms and text before the token name none.
export const menuActions = ({
  token,
  text,
  actions,
  state,
  titan,
}: {
  token: FilterToken | null
  text: string
  actions: OracleAction[]
  state: TitanState
  titan: Titan
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
        titan,
      })),
  ]
}

// What the Oracle lists for a query and its badges, grouped: projects, tasks, conversations, then settings and actions.
export function oracleResults({
  state,
  hits,
  projects,
  actions,
  cardActions,
  titan,
  text,
  badges,
  now,
}: {
  state: TitanState
  hits: Hit[]
  projects: TitanProjectSummary[]
  actions: OracleAction[]
  // What each task's worker is doing now, which its status badge shows.
  cardActions: Record<string, CurrentAction>
  titan: Titan
  text: string
  badges: Filter[]
  now: number
}): ResultGroup[] {
  const words = tokens({ text })
  const chatHits = hits.filter(hit => hit.kind === 'titan')
  const cardHits = hits.flatMap(hit => {
    const card = hit.kind === 'titan' ? undefined : state.cards[hit.card]

    return card && !card.hidden ? [
      {
        hit,
        card,
      },
    ] : []
  })
  const found = new Set(cardHits.map(({ card }) => card.id))
  // filterCards also matches a card's key, tags, link numbers and status badge text, which the index doesn't hold.
  const cardMatches = text ? filterCards({
    state,
    query: text,
    actions: cardActions,
  }).filter(card => card.id !== TITAN_CARD && !found.has(card.id))
    .map(card => taskResult({
      state,
      card,
      titan,
    })) : []
  const tasks = text
    ? [
      ...cardHits.map(({
        hit,
        card,
      }) => taskResult({
        state,
        card,
        hit,
        titan,
      })),
      ...cardMatches,
    ]
    : recentCards({ state }).map(card => taskResult({
      state,
      card,
      titan,
    }))
  const chat = chatHits.map(hit => conversationResult({
    hit,
    at: newestSnippet({ hit }),
    titan,
  }))
  const ownChat = conversationResult({
    at: state.cards[TITAN_CARD]?.updatedAt,
    titan,
  })
  const taskChats = recentCards({ state }).filter(card => hasConversation({ card }))
    .map(card => taskConversation({
      card,
      titan,
    }))
  const conversations = text ? chat : [
    ownChat,
    ...taskChats,
  ]

  const projectResults = projects.filter(project => words.every(word => `${project.name} ${project.path}`.toLowerCase().includes(word)))
    .map((project): OracleResult => ({
      id: `project:${project.path}`,
      kind: 'project',
      title: project.name,
      titan: titan.id,
      titanName: titan.name,
      project: project.path,
      summary: project,
    }))
  const settings = searchSettings({ query: text }).map(match => settingResult({ match }))
  const panels = oraclePanels({ state }).filter(panel => matchesCommand({
    query: text,
    text: `${panel.label} ${panel.words}`,
  }))
    .map(panel => panelResult({
      panel,
      titan,
    }))
  const actionResults = actions.filter(action => matchesCommand({
    query: text,
    text: `${action.label} ${action.words}`,
  }))
    .map(action => actionResult({ action }))
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

export const countLabel = ({
  pending,
  failed,
  count,
}: {
  pending: boolean
  failed: boolean
  count: number
}) => {
  if (pending) {
    return 'Searching…'
  }

  if (failed) {
    return 'Search unavailable'
  }

  return `${count} ${count === 1 ? 'result' : 'results'}`
}

export const resultIcon = ({ result }: { result: OracleResult }) => {
  switch (result.kind) {
    case 'task':
      return 'task'
    case 'conversation':
      return 'comments'
    case 'project':
      return 'project'
    case 'setting':
      return SETTING_ICONS[result.match.entry.id] ?? 'settings'
    case 'panel':
      return result.panel.panel === 'projects' ? 'project' : 'agent'
    case 'action':
      return ACTION_ICONS[result.action.run]
  }
}

export function resultMeta({
  result,
  state,
  now,
  actions,
}: {
  actions: Record<string, CurrentAction>
  result: OracleResult
  state: TitanState
  now: number
}): string {
  switch (result.kind) {
    case 'task':
      return `${result.titanName ?? ''} · ${statusLabel({
        status: taskRollup({
          state,
          card: result.card,
          actions,
        }).status,
      })} · ${relativeTime({
        at: result.at,
        now,
      })}`
    case 'conversation':
      return conversationMeta({
        result,
        now,
      })
    case 'project':
      return result.summary.path
    case 'setting':
      return SETTINGS_SECTIONS.find(section => section.id === result.match.entry.section)?.label ?? ''
    case 'panel':
      return ''
    case 'action':
      return ''
  }
}

const conversationMeta = ({
  result,
  now,
}: {
  result: Extract<OracleResult, { kind: 'conversation' }>
  now: number
}) => {
  const when = result.at ? relativeTime({
    at: result.at,
    now,
  }) : ''

  return result.card ? `Task · ${when}` : when
}

export const menuHint = ({ filter }: { filter: Filter }) => {
  const words = filter.label.toLowerCase().split(' ')

  return `${TYPE_LABELS[filter.type]} · >${words.at(-1)}`
}

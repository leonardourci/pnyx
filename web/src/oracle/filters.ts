import type { HydraProjectSummary } from '#app/server-hydras.ts'
import type { HydraColumn } from '#tasks/columns-model.ts'
import { columnLook } from '#web-tasks/view.ts'

// A panel is a whole settings block from the old Oracle rows, such as Projects.
export type ResultKind = 'project' | 'task' | 'conversation' | 'setting' | 'panel' | 'action'
export type FilterType = 'kind' | 'hydra' | 'column' | 'project' | 'when'

export const RESULT_KINDS: ResultKind[] = [
  'project',
  'task',
  'conversation',
  'setting',
  'panel',
  'action',
]
export const FILTER_TYPES: FilterType[] = [
  'kind',
  'hydra',
  'column',
  'project',
  'when',
]
export const TYPE_LABELS: Record<FilterType, string> = {
  kind: 'Kind',
  hydra: 'Hydra',
  column: 'Column',
  project: 'Project',
  when: 'When',
}
// Which results a filter type can narrow; settings and actions pass a Hydra badge because they apply to every Hydra.
export const APPLIES: Record<FilterType, ResultKind[]> = {
  kind: RESULT_KINDS,
  hydra: RESULT_KINDS,
  column: ['task'],
  project: [
    'project',
    'task',
    'conversation',
  ],
  when: [
    'task',
    'conversation',
  ],
}
// The long forms, such as in:progress, name one filter type.
const LONG_FORMS: Record<string, FilterType> = {
  kind: 'kind',
  hydra: 'hydra',
  in: 'column',
  project: 'project',
  when: 'when',
}
const TOKEN = /(?:^|\s)(>\S*|(?:kind|hydra|in|project|when):\S*)$/i
const DAY_MS = 24 * 60 * 60 * 1000
const WEEK_DAYS = 7

export interface Filter {
  id: string
  type: FilterType
  label: string
  icon: string
  // What a result's own field must be: its kinds, a column id, a project's path and references, a Hydra id or a time window.
  values: string[]
  // More words the menu finds it by.
  words?: string
}

// What a result shows the filters.
export interface Candidate {
  kind: ResultKind
  hydra?: string
  column?: string
  project?: string
  at?: string
}

export const KIND_FILTERS: Filter[] = [
  {
    id: 'kind:tasks',
    type: 'kind',
    label: 'Tasks',
    icon: 'task',
    values: ['task'],
    words: 'cards',
  },
  {
    id: 'kind:conversations',
    type: 'kind',
    label: 'Conversations',
    icon: 'comments',
    values: ['conversation'],
    words: 'messages chat',
  },
  {
    id: 'kind:projects',
    type: 'kind',
    label: 'Projects',
    icon: 'project',
    values: ['project'],
    words: 'folders repositories',
  },
  {
    id: 'kind:settings',
    type: 'kind',
    label: 'Settings',
    icon: 'settings',
    values: [
      'setting',
      'panel',
      'action',
    ],
    words: 'actions preferences',
  },
]
const WHEN_FILTERS: Filter[] = [
  {
    id: 'when:today',
    type: 'when',
    label: 'Today',
    icon: 'reminder',
    values: ['today'],
  },
  {
    id: 'when:week',
    type: 'when',
    label: 'This week',
    icon: 'reminder',
    values: ['week'],
  },
]

export const hydraFilter = ({ hydra }: {
  hydra: {
    id: string
    name: string
    icon: string
  }
}): Filter => ({
  id: `hydra:${hydra.id}`,
  type: 'hydra',
  label: hydra.name,
  icon: hydra.icon,
  values: [hydra.id],
  words: 'hydra',
})

// Every filter the menu can offer: the kinds, the current Hydra, its columns and projects, and the time windows.
export function filterOptions({
  hydra,
  columns,
  projects,
}: {
  hydra: Filter
  columns: HydraColumn[]
  projects: HydraProjectSummary[]
}): Filter[] {
  return [
    ...KIND_FILTERS,
    hydra,
    ...columns.map((column): Filter => ({
      id: `column:${column.id}`,
      type: 'column',
      label: column.title,
      icon: columnLook({ column }).icon,
      values: [column.id],
    })),
    ...projects.map((project): Filter => ({
      id: `project:${project.path}`,
      type: 'project',
      label: project.name,
      icon: 'project',
      values: project.references,
      words: project.path,
    })),
    ...WHEN_FILTERS,
  ]
}

export interface FilterToken {
  text: string
  // A long form names its type; > searches every type.
  type?: FilterType
  needle: string
}

// The half-typed filter at the end of the query, if any.
export function filterToken({ query }: { query: string }): FilterToken | null {
  const text = TOKEN.exec(query)?.[1]

  if (text === undefined) {
    return null
  }

  if (text.startsWith('>')) {
    return {
      text,
      needle: text.slice(1).toLowerCase(),
    }
  }

  const colon = text.indexOf(':')

  return {
    text,
    type: LONG_FORMS[text.slice(
      0,
      colon,
    ).toLowerCase()],
    needle: text.slice(colon + 1).toLowerCase(),
  }
}

// The query without its half-typed filter, which is what the search reads.
export const queryText = ({ query }: { query: string }) => query.replace(
  TOKEN,
  '',
).trim()

// The kinds of result still possible under these badges; two badges of one type mean either.
export function possibleKinds({ badges }: { badges: Filter[] }): ResultKind[] {
  return RESULT_KINDS.filter(kind => FILTER_TYPES.every(type => {
    const chosen = badges.filter(badge => badge.type === type)

    if (!chosen.length) {
      return true
    }

    return type === 'kind' ? chosen.some(badge => badge.values.includes(kind)) : APPLIES[type].includes(kind)
  }))
}

const named = ({
  filter,
  needle,
}: {
  filter: Filter
  needle: string
}) => {
  const label = filter.label.toLowerCase()
  const words = `${label} ${filter.words ?? ''}`.split(/[\s/-]+/)

  return !needle || label.startsWith(needle) || words.some(word => word.startsWith(needle))
}

// The filters a half-typed token can become: not chosen yet, of its type, and still leaving some result.
export function filterMenu({
  token,
  badges,
  options,
}: {
  token: FilterToken
  badges: Filter[]
  options: Filter[]
}): Filter[] {
  return options.filter(filter => !badges.some(badge => badge.id === filter.id)
    && (!token.type || filter.type === token.type)
    && possibleKinds({
      badges: [
        ...badges,
        filter,
      ],
    }).length > 0
    && named({
      filter,
      needle: token.needle,
    }))
}

// The query once its token became a badge: the text before it, ready for more.
export const committedQuery = ({ query }: { query: string }) => {
  const text = queryText({ query })

  return text ? `${text} ` : ''
}

// Hydra badges lead the bar, the rest follow in the order typed.
export const addBadge = ({
  badges,
  filter,
}: {
  badges: Filter[]
  filter: Filter
}) => filter.type === 'hydra' ? [
  filter,
  ...badges,
] : [
  ...badges,
  filter,
]

const since = ({
  window,
  now,
}: {
  window: string
  now: number
}) => {
  if (window === 'today') {
    return new Date(now).setHours(
      0,
      0,
      0,
      0,
    )
  }

  return now - WEEK_DAYS * DAY_MS
}

function passesType({
  item,
  type,
  chosen,
  now,
}: {
  item: Candidate
  type: FilterType
  chosen: Filter[]
  now: number
}): boolean {
  if (type === 'kind') {
    return chosen.some(badge => badge.values.includes(item.kind))
  }

  if (!APPLIES[type].includes(item.kind)) {
    return false
  }

  if (type === 'hydra') {
    return item.hydra === undefined || chosen.some(badge => badge.values.includes(item.hydra!))
  }

  if (type === 'when') {
    const at = item.at ? Date.parse(item.at) : NaN

    return chosen.some(badge => at >= since({
      window: badge.values[0]!,
      now,
    }))
  }

  const value = type === 'column' ? item.column : item.project

  return value !== undefined && chosen.some(badge => badge.values.includes(value))
}

// Different types narrow together; badges of one type mean either.
export function passes({
  item,
  badges,
  now,
}: {
  item: Candidate
  badges: Filter[]
  now: number
}): boolean {
  return FILTER_TYPES.every(type => {
    const chosen = badges.filter(badge => badge.type === type)

    return !chosen.length || passesType({
      item,
      type,
      chosen,
      now,
    })
  })
}

// No text and only Hydra badges: the Oracle lists recent tasks.
export const recentOnly = ({
  text,
  badges,
}: {
  text: string
  badges: Filter[]
}) => !text && badges.every(badge => badge.type === 'hydra')

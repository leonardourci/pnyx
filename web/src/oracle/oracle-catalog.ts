import { tokens } from '#oracle/query.ts'
import type { HydraState } from '#app/model.ts'

export type OracleAction = {
  id: string
  label: string
  words: string
  does: string
} & ({
  run: 'task'
  column: string
} | { run: 'column' } | { run: 'ask' })

export const ACTION_ICONS = {
  task: 'plus',
  column: 'plus',
  ask: 'comments',
} as const

export interface OraclePanel {
  id: string
  label: string
  words: string
  panel: 'projects' | 'agents'
}

// The Projects and Agents blocks, which have no other place in the web app; their previews hold the whole block.
export const oraclePanels = ({ state }: { state: HydraState }): OraclePanel[] => [
  {
    id: 'panel:projects',
    label: 'Projects',
    words: `folder attach clone detach landing command ${(state.projects ?? []).map(project => project.name).join(' ')}`,
    panel: 'projects',
  },
  {
    id: 'panel:agents',
    label: 'Hydra identity and default model; heads dispatch rules',
    words: `harness effort mode quota launch worker ${Object.keys(state.config?.agents ?? {}).join(' ')}`,
    panel: 'agents',
  },
]

export function oracleActions({
  columns,
}: {
  columns: {
    id: string
    title: string
  }[]
}): OracleAction[] {
  return [
    {
      id: 'action:ask',
      label: 'Ask a Hydra',
      words: 'request message send',
      does: 'Enter starts a request to a Hydra, as typing ask and a space does.',
      run: 'ask',
    },
    ...columns.map((column): OracleAction => ({
      id: `action:task:${column.id}`,
      label: `New task in ${column.title}`,
      words: 'create add card',
      does: `Enter opens a new task form at the top of ${column.title}.`,
      run: 'task',
      column: column.id,
    })),
    {
      id: 'action:column',
      label: 'Add project',
      words: 'create add layout',
      does: 'Attach a repository or a folder of repositories.',
      run: 'column',
    },

  ]
}

const CONCEPTS = [
  [
    'new',
    'create',
    'add',
  ],
]

export function matchesCommand({
  query,
  text,
}: {
  query: string
  text: string
}): boolean {
  const words = tokens({ text: query })
  const haystack = text.toLowerCase()

  return words.every(word => haystack.includes(word)
    || CONCEPTS.some(group => group.includes(word) && group.some(term => haystack.includes(term))))
}

import type { HydraState } from '#app/model.ts'
import type { HydraColumn } from '#tasks/columns-model.ts'
import { KEY_ACTIONS, type KeyScope } from '#preferences/keyboard.ts'

// Keys that open, close or type into the Oracle itself are no use as its rows.
const OWN_KEYS = [
  'palette',
  'search',
  'help',
  'cancel',
  'send',
]

export type OracleAction = {
  id: string
  label: string
  words: string
  does: string
} & ({
  run: 'task'
  column: string
} | { run: 'column' } | { run: 'ask' } | {
  run: 'key'
  key: string
})

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
  scope,
}: {
  columns: HydraColumn[]
  scope: KeyScope
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
      label: 'New column',
      words: 'create add layout',
      does: 'Enter adds a column at the end of the Hydra and lets you name it.',
      run: 'column',
    },
    ...KEY_ACTIONS.filter(entry => !OWN_KEYS.includes(entry.id) && entry.scopes.includes(scope))
      .map((entry): OracleAction => ({
        id: `action:key:${entry.id}`,
        label: entry.label,
        words: 'keyboard shortcut action',
        does: `Enter runs “${entry.label}” where you opened the Oracle, as its shortcut does.`,
        run: 'key',
        key: entry.id,
      })),
  ]
}

const CONCEPTS = [
  [
    'new',
    'create',
    'add',
  ],
  [
    'keyboard',
    'shortcut',
    'binding',
    'keys',
  ],
]

export function matchesCommand({
  query,
  text,
}: {
  query: string
  text: string
}): boolean {
  const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  const haystack = text.toLowerCase()

  return words.every(word => haystack.includes(word)
    || CONCEPTS.some(group => group.includes(word) && group.some(term => haystack.includes(term))))
}

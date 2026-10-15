import type { BoardState, ViewPreferences } from '../../../src/core/model.ts'
import { columnsFor } from './view.ts'
import { DEFAULT_VIEW, VIEW_SIZE_LIMITS } from '../../../src/core/view.ts'

export type SearchSetting = {
  id: string
  label: string
  words: string
} & (
  | { type: 'toggle'; value: boolean; patch({ value }: { value: boolean }): unknown }
  | { type: 'choice'; value: string; options: { value: string; label: string }[]; patch({ value }: { value: string }): unknown }
  | { type: 'number'; value: number; min: number; max: number; patch({ value }: { value: number }): unknown }
)

export function searchSettings({ state, view }: {
  state: BoardState
  view: ViewPreferences
}): SearchSetting[] {
  const numberKeys = [
    ['fontSize', 'UI font size'],
    ['chatFontSize', 'Chat font size'],
    ['codeFontSize', 'Code font size'],
    ['panelWidth', 'Panel width'],
    ['composerHeight', 'Composer height'],
    ['cardHeight', 'Default card height'],
  ] as const

  return [
    { id: 'theme', label: 'Theme', words: 'appearance dark light system night color', type: 'choice', value: view.theme, options: ['system', 'light', 'dark'].map(value => ({ value, label: value })), patch: ({ value }) => ({ theme: value }) },
    ...numberKeys.map(([id, label]): SearchSetting => ({ id, label, words: 'reading text size zoom width height', type: 'number', value: view[id], ...VIEW_SIZE_LIMITS[id], patch: ({ value }) => ({ [id]: value }) })),
    { id: 'panelPlacement', label: 'Conversation placement', words: 'conversation inline right panel location', type: 'choice', value: view.panelPlacement, options: [{ value: 'inline', label: 'Inline with cards' }, { value: 'right', label: 'Right panel' }], patch: ({ value }) => ({ panelPlacement: value }) },
    ...([
      ['cardColors', 'Card accent colors', 'color appearance'],
      ['toolDetails', 'Tool call details', 'tool calls expand traces'],
      ['thinkingDetails', 'Thinking details', 'reasoning expand traces'],
    ] as const).map(([id, label, words]): SearchSetting => ({ id, label, words, type: 'toggle', value: view[id], patch: ({ value }) => ({ [id]: value }) })),
    { id: 'focus', label: 'Focus mode', words: 'hide tools thinking distraction quiet reading', type: 'toggle', value: !view.toolDetails && !view.thinkingDetails, patch: ({ value }) => ({ toolDetails: !value, thinkingDetails: !value }) },
    { id: 'characterShortcuts', label: 'Character shortcuts', words: 'keyboard keys typing', type: 'toggle', value: view.keyboard.characterShortcuts, patch: ({ value }) => ({ keyboard: { characterShortcuts: value } }) },
    ...columnsFor({ state }).map((column): SearchSetting => ({
      id: `width:${column.id}`,
      label: `${column.title} column width`,
      words: 'resize layout size',
      type: 'number',
      value: view.columnWidths[column.id] ?? 290,
      ...VIEW_SIZE_LIMITS.columnWidth,
      patch: ({ value }) => ({ columnWidths: { [column.id]: value } }),
    })),
  ]
}

const CONCEPTS = [
  ['font', 'text', 'reading', 'letters', 'readability'],
  ['size', 'bigger', 'larger', 'smaller', 'zoom', 'resize', 'width', 'height'],
  ['theme', 'appearance', 'dark', 'light', 'night'],
  ['focus', 'quiet', 'distraction', 'concentrate'],
  ['thinking', 'reasoning', 'thoughts'],
  ['search', 'find', 'lookup', 'meaning', 'semantic'],
  ['new', 'create', 'add'],
  ['remove', 'delete', 'discard'],
  ['rename', 'name', 'title'],
  ['reset', 'restore', 'defaults'],
  ['keyboard', 'shortcut', 'binding', 'keys'],
  ['hydra', 'assistant', 'orchestrator'],
]

export const commandQuery = ({ query }: { query: string }) => query.trimStart().startsWith('>')
export const searchWords = ({ query }: { query: string }) => query.replace(/^\s*>/, '').trim()

export function matchesCommand({ query, text }: { query: string; text: string }): boolean {
  const words = searchWords({ query }).toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? []
  const haystack = text.toLowerCase()

  return words.every(word => haystack.includes(word)
    || CONCEPTS.some(group => group.includes(word) && group.some(term => haystack.includes(term))))
}

export const resetWidths = ({ view }: { view: ViewPreferences }) => ({
  panelWidth: DEFAULT_VIEW.panelWidth,
  columnWidths: Object.fromEntries(Object.keys(view.columnWidths).map(id => [id, null])),
})

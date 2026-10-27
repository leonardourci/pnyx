import type { HydraState } from '../../../src/app/model.ts'
import type { ViewPreferences } from '../../../src/core/model.ts'
import { resetLayoutWidths, VIEW_SIZE_LIMITS } from '../../../src/core/view.ts'

export type OracleSetting = {
  id: string
  label: string
  words: string
} & (
  | {
    type: 'toggle'
    value: boolean
    patch({ value }: { value: boolean }): unknown
  }
  | {
    type: 'choice'
    value: string
    options: {
      value: string
      label: string
    }[]
    patch({ value }: { value: string }): unknown
  }
  | {
    type: 'number'
    value: number
    min: number
    max: number
    patch({ value }: { value: number }): unknown
  }
)

export function oracleSettings({ view }: {
  state: HydraState
  view: ViewPreferences
}): OracleSetting[] {
  const numberKeys = [
    [
      'fontSize',
      'UI font size',
    ],
    [
      'chatFontSize',
      'Chat font size',
    ],
    [
      'codeFontSize',
      'Code font size',
    ],
  ] as const

  return [
    {
      id: 'theme',
      label: 'Theme',
      words: 'appearance dark light system night color',
      type: 'choice',
      value: view.theme,
      options: [
        'system',
        'light',
        'dark',
      ].map(value => ({
        value,
        label: value,
      })),
      patch: ({ value }) => ({ theme: value }),
    },
    ...numberKeys.map(([
      id,
      label,
    ]): OracleSetting => ({
      id,
      label,
      words: 'reading text size zoom width height',
      type: 'number',
      value: view[id],
      ...VIEW_SIZE_LIMITS[id],
      patch: ({ value }) => ({ [id]: value }),
    })),
    ...([
      [
        'focusMode',
        'Focus mode',
        'hide tools thinking distraction quiet reading',
      ],
      [
        'lastMessageOnCards',
        'Last message on cards',
        'preview latest reply cards',
      ],
      [
        'toolDetails',
        'Tool call details',
        'tool calls expand traces',
      ],
      [
        'thinkingDetails',
        'Thinking details',
        'reasoning expand traces',
      ],
    ] as const).map(([
      id,
      label,
      words,
    ]): OracleSetting => ({
      id,
      label,
      words,
      type: 'toggle',
      value: view[id],
      patch: ({ value }) => ({ [id]: value }),
    })),
    {
      id: 'characterShortcuts',
      label: 'Character shortcuts',
      words: 'keyboard keys typing',
      type: 'toggle',
      value: view.keyboard.characterShortcuts,
      patch: ({ value }) => ({ keyboard: { characterShortcuts: value } }),
    },

  ]
}

const CONCEPTS = [
  [
    'font',
    'text',
    'reading',
    'letters',
    'readability',
  ],
  [
    'size',
    'bigger',
    'larger',
    'smaller',
    'zoom',
    'resize',
    'width',
    'height',
  ],
  [
    'theme',
    'appearance',
    'dark',
    'light',
    'night',
  ],
  [
    'focus',
    'quiet',
    'distraction',
    'concentrate',
  ],
  [
    'thinking',
    'reasoning',
    'thoughts',
  ],
  [
    'search',
    'find',
    'lookup',
  ],
  [
    'new',
    'create',
    'add',
  ],
  [
    'remove',
    'delete',
    'discard',
  ],
  [
    'rename',
    'name',
    'title',
  ],
  [
    'reset',
    'restore',
    'defaults',
  ],
  [
    'keyboard',
    'shortcut',
    'binding',
    'keys',
  ],
  [
    'hydra',
    'assistant',
    'orchestrator',
  ],
]

export const SHORTCUT_QUERY = '> shortcut'
export const shortcutLabel = ({ label }: { label: string }) => `${label} shortcut`
export const commandQuery = ({ query }: { query: string }) => query.trimStart().startsWith('>')
const queryWords = ({ query }: { query: string }) => query.replace(
  /^\s*>/,
  '',
).trim()

export function matchesCommand({
  query,
  text,
}: {
  query: string
  text: string
}): boolean {
  const words = queryWords({ query }).toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? []
  const haystack = text.toLowerCase()

  return words.every(word => haystack.includes(word)
    || CONCEPTS.some(group => group.includes(word) && group.some(term => haystack.includes(term))))
}

export const resetWidths = resetLayoutWidths

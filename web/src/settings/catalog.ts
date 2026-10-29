// Every setting the Settings page shows, with the words a search finds it by; the Oracle will move to this list.
export const SETTINGS_SECTIONS = [
  {
    id: 'appearance',
    label: 'Appearance',
    icon: 'theme',
  },
  {
    id: 'layout',
    label: 'Layout',
    icon: 'columns',
  },
  {
    id: 'cards',
    label: 'Cards and chat',
    icon: 'cards',
  },
  {
    id: 'hydra',
    label: 'Hydra',
    icon: 'hydra',
  },
  {
    id: 'agent',
    label: 'Hydra’s default agent',
    icon: 'model',
  },
  {
    id: 'dispatch',
    label: 'Heads dispatch',
    icon: 'dispatch',
  },
  {
    id: 'keyboard',
    label: 'Keyboard',
    icon: 'keyboard',
  },
  {
    id: 'about',
    label: 'About',
    icon: 'about',
  },
] as const

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]['id']

export interface CatalogEntry {
  id: string
  section: SettingsSection
  label: string
  description: string
  // The values a control offers, so searching for "dark" finds Theme.
  values?: string[]
  // Words that only widen a search word matching nothing directly, so "bigger" finds the text sizes.
  related: string[]
}

const TEXT_SIZE = [
  'font',
  'bigger',
  'smaller',
  'zoom',
  'scale',
  'readable',
]

export const SETTINGS_CATALOG: CatalogEntry[] = [
  {
    id: 'theme',
    section: 'appearance',
    label: 'Theme',
    description: 'Follow the system, or always use the light or dark colors.',
    values: [
      'System',
      'Light',
      'Dark',
    ],
    related: [
      'color',
      'night',
      'mode',
      'appearance',
    ],
  },
  {
    id: 'fontSize',
    section: 'appearance',
    label: 'Interface text size',
    description: 'Labels, cards, columns and menus.',
    related: TEXT_SIZE,
  },
  {
    id: 'chatFontSize',
    section: 'appearance',
    label: 'Chat text size',
    description: 'Messages in Hydra’s chat and in task conversations.',
    related: TEXT_SIZE,
  },
  {
    id: 'codeFontSize',
    section: 'appearance',
    label: 'Code text size',
    description: 'Code blocks, commands and tool details.',
    related: [
      ...TEXT_SIZE,
      'monospace',
    ],
  },
  {
    id: 'defaultColumnWidths',
    section: 'layout',
    label: 'Column widths',
    description: 'The width each column starts at in every Hydra. Dragging a column edge changes only that Hydra.',
    related: [
      'wide',
      'narrow',
      'size',
      'board',
    ],
  },
  {
    id: 'defaultHydraWidth',
    section: 'layout',
    label: 'Hydra chat width',
    description: 'The width Hydra’s chat starts at in every Hydra.',
    related: [
      'wide',
      'narrow',
      'size',
      'panel',
    ],
  },
  {
    id: 'resetWidths',
    section: 'layout',
    label: 'Reset dragged widths',
    description: 'Return every Hydra’s columns and chat to the widths above.',
    related: [
      'restore',
      'default',
      'size',
    ],
  },
  {
    id: 'lastMessageOnCards',
    section: 'cards',
    label: 'Agent updates on cards',
    description: 'Show each worker’s latest message on its card.',
    related: [
      'preview',
      'status',
      'progress',
    ],
  },
  {
    id: 'focusMode',
    section: 'cards',
    label: 'Focus mode',
    description: 'Show only messages in a conversation and hide tool calls and thinking.',
    related: [
      'quiet',
      'clean',
      'distraction',
    ],
  },
  {
    id: 'toolDetails',
    section: 'cards',
    label: 'Tool details',
    description: 'Open each tool call’s input and output by default.',
    related: [
      'commands',
      'calls',
      'expand',
    ],
  },
  {
    id: 'thinkingDetails',
    section: 'cards',
    label: 'Thinking details',
    description: 'Open each agent’s thinking by default.',
    related: [
      'reasoning',
      'expand',
    ],
  },
  {
    id: 'doneAfterHours',
    section: 'hydra',
    label: 'Hide Done cards',
    description: 'Take finished cards off the board once they have been in Done this long.',
    values: ['Off'],
    related: [
      'archive',
      'clean',
      'finished',
      'completed',
      'retention',
    ],
  },
  {
    id: 'reviewMinutes',
    section: 'hydra',
    label: 'Review cadence',
    description: 'How often Hydra looks over the board for anything that needs action. It still wakes right away for your messages and for worker updates.',
    related: [
      'timer',
      'interval',
      'minutes',
      'often',
      'check',
    ],
  },
  {
    id: 'helper',
    section: 'hydra',
    label: 'Routine helper',
    description: 'A lighter agent that handles Hydra’s routine wakes, so the main Hydra spends its quota on your messages and decisions.',
    values: [
      'Auto',
      'Off',
      'Choose',
    ],
    related: [
      'cheaper',
      'quota',
      'sonnet',
      'luna',
      'wakes',
    ],
  },
  {
    id: 'hydraAgent',
    section: 'agent',
    label: 'Model, effort and permissions',
    description: 'Every Hydra session starts on this. The model picker in Hydra’s chat can switch a running session; pinning there saves the choice here.',
    related: [
      'orchestrator',
      'opus',
      'sonnet',
      'codex',
      'claude',
      'fast',
    ],
  },
  {
    id: 'headsDispatch',
    section: 'dispatch',
    label: 'Heads dispatch',
    description: 'Which agent and which login each worker gets. Changes are checked before they save, and Hydra’s proposed changes wait for your Confirm.',
    related: [
      'rules',
      'workers',
      'agents',
      'models',
      'effort',
      'permissions',
      'candidates',
      'accounts',
      'logins',
      'quota',
      'proposals',
      'routing',
    ],
  },
  {
    id: 'keyboard',
    section: 'keyboard',
    label: 'Keyboard shortcuts',
    description: 'The keys for each action, including single-character shortcuts.',
    related: [
      'keys',
      'hotkeys',
      'bindings',
    ],
  },
  {
    id: 'version',
    section: 'about',
    label: 'Version and upgrade',
    description: 'The running build and whether a newer Pnyx is available.',
    related: [
      'update',
      'release',
      'build',
      'license',
      'credits',
    ],
  },
]

export interface SettingsMatch {
  entry: CatalogEntry
  // The query words found directly, for highlighting.
  terms: string[]
}

const words = ({ text }: { text: string }) => text.toLowerCase().split(/\s+/)
  .filter(Boolean)

const directText = ({ entry }: { entry: CatalogEntry }) => [
  entry.label,
  entry.description,
  ...entry.values ?? [],
].join(' ')
  .toLowerCase()

export function searchSettings({
  query,
  entries = SETTINGS_CATALOG,
}: {
  query: string
  entries?: CatalogEntry[]
}): SettingsMatch[] {
  const asked = words({ text: query })
  const direct = new Set(asked
    .filter(word => entries.some(entry => directText({ entry }).includes(word))))

  return entries.flatMap(entry => {
    const text = directText({ entry })
    const found = asked.every(word => direct.has(word)
      ? text.includes(word)
      : entry.related.some(related => related.startsWith(word)))

    return found ? [
      {
        entry,
        terms: asked.filter(word => direct.has(word)),
      },
    ] : []
  })
}

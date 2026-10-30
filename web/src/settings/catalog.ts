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
    note: 'Defaults apply to every column you have not resized by dragging its edge.',
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
    note: 'The agent the orchestrator itself runs on, in every Hydra. Your workers do not use this; they follow Heads dispatch.',
  },
  {
    id: 'dispatch',
    label: 'Heads dispatch',
    icon: 'dispatch',
    note: 'Which agent and which login each worker gets. Changes are checked before they save, and Hydra’s suggested changes wait for your Confirm.',
  },
  {
    id: 'keyboard',
    label: 'Keyboard',
    icon: 'keyboard',
    note: 'An action can have several keys. Press + on a row to add one, or ✕ on a key to drop it.',
  },
  {
    id: 'about',
    label: 'About',
    icon: 'about',
  },
] as const satisfies readonly {
  id: string
  label: string
  icon: string
  // A line under the heading that frames the whole section.
  note?: string
}[]

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
    description: 'System follows your computer’s light or dark setting.',
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
    description: 'Cards and their tags, columns, menus and labels.',
    related: TEXT_SIZE,
  },
  {
    id: 'chatFontSize',
    section: 'appearance',
    label: 'Chat text size',
    description: 'Messages in Hydra’s chat and in task conversations. Task mentions, skills, commands, links and images scale with the text.',
    related: TEXT_SIZE,
  },
  {
    id: 'codeFontSize',
    section: 'appearance',
    label: 'Code text size',
    description: 'Code blocks, commands and diffs.',
    related: [
      ...TEXT_SIZE,
      'monospace',
    ],
  },
  {
    id: 'defaultColumnWidths',
    section: 'layout',
    label: 'Default column width',
    description: 'Used by columns without a per-column override, in every Hydra. Open “Per column” to set an override.',
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
    label: 'Default Hydra chat width',
    description: 'The chat’s width until you drag it, and what Reset returns it to.',
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
    label: 'Dragged widths',
    description: 'Return every Hydra’s columns and chat to the defaults above.',
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
    description: 'Show each worker’s latest message at the bottom of its card.',
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
    description: 'Hide tool calls and thinking so conversations read as messages only. A card can still show them on its own.',
    related: [
      'quiet',
      'clean',
      'distraction',
    ],
  },
  {
    id: 'toolDetails',
    section: 'cards',
    label: 'Tool call details',
    description: 'Open tool rows so their input and output show without a click.',
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
    description: 'Open thinking rows so the reasoning shows without a click.',
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
      'Automatic',
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
    label: 'Character shortcuts',
    description: 'Single-letter keys such as j and k. Text fields always keep normal typing.',
    related: [
      'keyboard',
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

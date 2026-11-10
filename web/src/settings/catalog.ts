import { tokens } from '#oracle/query.ts'

export const SETTING_ICONS: Record<string, string> = {
  theme: 'theme',
  fontSize: 'text-size',
  chatFontSize: 'comment',
  codeFontSize: 'tool',
  defaultColumnWidths: 'columns',
  defaultHydraWidth: 'chat-width',
  resetWidths: 'reset',
  lastMessageOnCards: 'cards',
  focusMode: 'focus',
  toolDetails: 'tool',
  thinkingDetails: 'thinking',
  headsDispatch: 'dispatch',
  keyboard: 'keyboard',
  version: 'about',
  doneAfterHours: 'done',
  reviewMinutes: 'reminder',
  helper: 'helper',
  hydraAgent: 'agent',
  accounts: 'you',
  logs: 'logs',
  logDays: 'log-days',
  logMaxMB: 'log-size',
}

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
    note: 'Save widths and resize this Hydra.',
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
    id: 'accounts',
    label: 'Accounts',
    icon: 'you',
    note: 'Claude Code and Codex logins from homes you already use. Hydra can also add one for you.',
  },
  {
    id: 'routine',
    label: 'Routine helper',
    icon: 'helper',
  },
  {
    id: 'reviews',
    label: 'Main Hydra reviews',
    icon: 'reminder',
    note: 'The helper handles routine worker events as they arrive. Periodic reviews are separate checks by the main Hydra.',
  },
  {
    id: 'agent',
    label: 'Hydra’s defaults',
    icon: 'model',
    note: 'Defaults for new sessions. Existing sessions and explicit worker dispatch retain their choices.',
  },
  {
    id: 'dispatch',
    label: 'Heads dispatch',
    icon: 'dispatch',
    note: 'Which agent and which login each worker gets. Hydra can update these settings and records each change in chat.',
  },
  {
    id: 'keyboard',
    label: 'Keyboard',
    icon: 'keyboard',
    note: 'An action can have several keys. Press + on a row to add one, or ✕ on a key to drop it.',
  },
  {
    id: 'logs',
    label: 'Logs',
    icon: 'logs',
    note: 'Timestamped lines on this machine for debugging Pnyx: what each action did, how long it took and how much memory the server used. pnyx-axi debug performance reads them.',
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
    label: 'Column width',
    description: 'Resize this Hydra’s columns and save the width for new columns.',
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
    description: 'Resize this Hydra’s chat and save the width for new Hydras.',
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
    label: 'Reset widths',
    description: 'Restore saved widths in every Hydra.',
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
    section: 'reviews',
    label: 'Review interval',
    description: 'How often the main Hydra reviews open work. This interval does not schedule the helper.',
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
    section: 'routine',
    label: 'Routine helper',
    description: 'A lower-cost agent handles routine worker updates and passes decisions to the main Hydra, so the main Hydra spends its quota on your messages and decisions.',
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
    label: 'Default selection',
    description: 'Provider, named account and model, with the controls that provider supports.',
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
    id: 'accounts',
    section: 'accounts',
    label: 'Accounts',
    description: 'Claude Code and Codex logins from homes you already use. Hydra can also add one for you.',
    related: [
      'login',
      'provider',
      'home',
      'folder',
      'register',
      'claude',
      'codex',
    ],
  },
  {
    id: 'headsDispatch',
    section: 'dispatch',
    label: 'Heads dispatch',
    description: 'Which agent and which login each worker gets. Hydra can update these settings and records each change in chat.',
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
    id: 'logs',
    section: 'logs',
    label: 'Logging',
    description: 'Off keeps only warnings and errors in the logs. On writes one line per action. Detailed adds a line for every live chat update and frame, for debugging streaming.',
    values: [
      'Off',
      'On',
      'Detailed',
    ],
    related: [
      'debug',
      'diagnostics',
      'performance',
      'metrics',
      'memory',
      'timing',
      'trace',
    ],
  },
  {
    id: 'logDays',
    section: 'logs',
    label: 'Keep logs for',
    description: 'Days of logs kept, today included; older days are deleted automatically.',
    related: [
      'retention',
      'days',
      'clean',
      'delete',
      'storage',
    ],
  },
  {
    id: 'logMaxMB',
    section: 'logs',
    label: 'Log size limit',
    description: 'The most space the logs take together. Older days go first; today’s file stays, and past the limit it keeps only warnings and errors.',
    related: [
      'disk',
      'space',
      'size',
      'megabytes',
      'storage',
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
  const asked = tokens({ text: query })
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

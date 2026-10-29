import type { HydraState } from '#app/model.ts'
import { HydraError } from '#store/errors.ts'
import type { ViewPreferences } from './model.ts'
import { COLUMNS } from '#tasks/columns-model.ts'
import { DEFAULT_KEYBOARD, KEY_ACTIONS, keyboardError } from './keyboard.ts'

export const DEFAULT_WIDTHS = {
  column: 380,
  hydra: 480,
} as const
export const DEFAULT_COLUMN_WIDTH = DEFAULT_WIDTHS.column
// Views saved before the defaults widened carry these as stored defaults; they count as unset.
const LEGACY_DEFAULT_WIDTHS = {
  column: 290,
  hydra: 360,
} as const

export const DEFAULT_VIEW: ViewPreferences = {
  theme: 'system',
  focusMode: true,
  lastMessageOnCards: true,
  hydraWidth: DEFAULT_WIDTHS.hydra,
  defaultHydraWidth: DEFAULT_WIDTHS.hydra,
  defaultColumnWidths: Object.fromEntries(COLUMNS.map(id => [
    id,
    DEFAULT_COLUMN_WIDTH,
  ])),
  keyboard: DEFAULT_KEYBOARD,
  fontSize: 14,
  chatFontSize: 16,
  codeFontSize: 13,
  panelPlacement: 'inline',
  panelWidth: 440,
  cardHeight: 250,
  cardColors: true,
  toolDetails: false,
  thinkingDetails: false,
  columnWidths: {},
  cardHeights: {},
  closedCardHeights: {},
  cardTraceOverrides: {},
  customColumns: [],
}

export const VIEW_SIZE_LIMITS = {
  panelWidth: { min: 320 },
  hydraWidth: { min: 240 },
  panelHeight: { min: 280 },
  fontSize: {
    min: 12,
    max: 20,
  },
  chatFontSize: {
    min: 12,
    max: 22,
  },
  codeFontSize: {
    min: 10,
    max: 20,
  },
  cardHeight: { min: 120 },
  columnWidth: { min: 240 },
  cardWidth: { min: 200 },
  columnHeight: { min: 200 },
} as const

export const clampViewSize = ({
  value,
  min,
  max,
}: {
  value: number
  min: number
  max?: number
}) =>
  Math.round(Math.max(
    min,
    Math.min(
      max ?? Infinity,
      value,
    ),
  ))

const persistedSize = ({
  value,
  fallback,
  min,
  max,
}: {
  value: unknown
  fallback: number
  min: number
  max?: number
}) =>
  typeof value === 'number' && Number.isFinite(value) ? clampViewSize({
    value,
    min,
    max,
  }) : fallback

const persistedMap = ({
  values,
  min,
  max,
}: {
  values: Record<string, number> | undefined
  min: number
  max?: number
}) =>
  Object.fromEntries(
    Object.entries(values ?? {}).map(([
      key,
      value,
    ]) =>
      [
        key,
        persistedSize({
          value,
          fallback: min,
          min,
          max,
        }),
      ]),
  )

export function traces({
  view,
  card,
}: {
  view: ViewPreferences
  card: string
}) {
  const overrides = view.cardTraceOverrides[card]
  const tools = !view.focusMode
  const thinking = !view.focusMode

  return {
    tools,
    thinking,
    focus: view.focusMode,
    overrides,
  }
}

// Shared settings, when given, win over the Hydra's own copy of the same preferences.
export const viewFor = ({
  state,
  settings,
}: {
  state: Pick<HydraState, 'view' | 'config'>
  settings?: Partial<ViewPreferences>
}): ViewPreferences => {
  const own = structuredClone(state.view ?? {}) as Partial<ViewPreferences>

  // Only a Hydra's own view from older releases can hold their saved default widths; shared values are literal.
  if (own.defaultHydraWidth === LEGACY_DEFAULT_WIDTHS.hydra) {
    delete own.defaultHydraWidth
  }

  if (own.defaultColumnWidths) {
    own.defaultColumnWidths = Object.fromEntries(Object.entries(own.defaultColumnWidths)
      .filter(([
        , width,
      ]) => width !== LEGACY_DEFAULT_WIDTHS.column))
  }

  const view = {
    ...structuredClone(DEFAULT_VIEW),
    ...own,
    ...structuredClone(settings),
  }
  const columnIds = new Set<string>([
    ...COLUMNS,
    ...(state.config?.columns ?? view.customColumns).map(column => column.id),
  ])

  return {
    ...view,
    keyboard: {
      ...view.keyboard,
      bindings: Object.fromEntries(Object.entries(view.keyboard.bindings)
        .filter(([id]) => KEY_ACTIONS.some(action => action.id === id))),
    },
    defaultHydraWidth: persistedSize({
      value: view.defaultHydraWidth,
      fallback: DEFAULT_VIEW.defaultHydraWidth,
      ...VIEW_SIZE_LIMITS.hydraWidth,
    }),
    defaultColumnWidths: {
      ...Object.fromEntries((state.config?.columns ?? view.customColumns)
        .map(c => [
          c.id,
          DEFAULT_COLUMN_WIDTH,
        ])),
      ...Object.fromEntries(Object.entries(persistedMap({
        values: view.defaultColumnWidths ?? {},
        ...VIEW_SIZE_LIMITS.columnWidth,
      })).filter(([id]) => columnIds.has(id))),
    },
    fontSize: persistedSize(
      {
        value: view.fontSize,
        fallback: DEFAULT_VIEW.fontSize,
        min: VIEW_SIZE_LIMITS.fontSize.min,
        max: VIEW_SIZE_LIMITS.fontSize.max,
      },
    ),
    chatFontSize: persistedSize(
      {
        value: view.chatFontSize,
        fallback: DEFAULT_VIEW.chatFontSize,
        min: VIEW_SIZE_LIMITS.chatFontSize.min,
        max: VIEW_SIZE_LIMITS.chatFontSize.max,
      },
    ),
    codeFontSize: persistedSize(
      {
        value: view.codeFontSize,
        fallback: DEFAULT_VIEW.codeFontSize,
        min: VIEW_SIZE_LIMITS.codeFontSize.min,
        max: VIEW_SIZE_LIMITS.codeFontSize.max,
      },
    ),
    hydraWidth: persistedSize({
      value: view.hydraWidth,
      fallback: DEFAULT_VIEW.hydraWidth,
      min: VIEW_SIZE_LIMITS.hydraWidth.min,
    }),
    panelWidth: persistedSize(
      {
        value: view.panelWidth,
        fallback: DEFAULT_VIEW.panelWidth,
        min: VIEW_SIZE_LIMITS.panelWidth.min,
      },
    ),
    cardHeight: persistedSize({
      value: view.cardHeight,
      fallback: DEFAULT_VIEW.cardHeight,
      ...VIEW_SIZE_LIMITS.cardHeight,
    }),
    columnWidths: persistedMap(
      {
        values: view.columnWidths,
        min: VIEW_SIZE_LIMITS.columnWidth.min,
      },
    ),
    cardHeights: persistedMap({
      values: view.cardHeights,
      ...VIEW_SIZE_LIMITS.cardHeight,
    }),
    closedCardHeights: persistedMap({
      values: view.closedCardHeights,
      ...VIEW_SIZE_LIMITS.cardHeight,
    }),
  }
}

export const resetLayoutWidths = ({ view }: { view: ViewPreferences }) => ({
  hydraWidth: view.defaultHydraWidth,
  columnWidths: {
    ...Object.fromEntries(Object.keys(view.columnWidths).map(id => [
      id,
      null,
    ])),
    ...Object.fromEntries(Object.entries(view.defaultColumnWidths)
      .filter(([
        , width,
      ]) => width !== DEFAULT_WIDTHS.column)),
  },
})

const invalid = ({ detail }: { detail: string }): never => {
  throw new HydraError({
    message: `invalid view preference: ${detail}`,
    code: 'VALIDATION_ERROR',
  })
}

const record = ({ value }: { value: unknown }): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
const safeKey = ({ key }: { key: string }) => ![
  '__proto__',
  'prototype',
  'constructor',
].includes(key)

const size = ({
  value,
  min,
  max,
  key,
}: {
  value: unknown
  min: number
  max?: number
  key: string
}) => {
  if (!Number.isInteger(value)
    || (value as number) < min || (value as number) > (max ?? Infinity)) {
    invalid({ detail: key })
  }

  return value as number
}

// A patch merges maps; null removes an individual override. All callers use this validator.
export function patchView({
  state,
  input: rawInput,
  settings,
}: {
  state: HydraState
  input: unknown
  // Shared settings to patch instead of the Hydra's own view.
  settings?: Partial<ViewPreferences>
}): ViewPreferences {
  const input = record({ value: rawInput })

  if (!input) {
    return invalid({ detail: 'expected an object' })
  }

  const next = structuredClone(viewFor({
    state,
    settings,
  }))
  const hydraColumnIds = state.config?.columns.map(c => c.id) ?? []

  for (const [
    key,
    value,
  ] of Object.entries(input).sort((
      [a],
      [b],
    ) => a === 'customColumns' ? -1 : b === 'customColumns' ? 1 : a.localeCompare(b))) {
    switch (key) {
      case 'keyboard': {
        const keyboard = record({ value })

        if (!keyboard || Object.keys(keyboard).some(k => ![
          'characterShortcuts',
          'bindings',
        ].includes(k))) {
          return invalid({ detail: key })
        }

        if (keyboard.characterShortcuts !== undefined) {
          if (typeof keyboard.characterShortcuts !== 'boolean') {
            return invalid({ detail: key })
          }

          next.keyboard.characterShortcuts = keyboard.characterShortcuts
        }

        if (keyboard.bindings === null) {
          next.keyboard.bindings = {}
        } else if (keyboard.bindings !== undefined) {
          const bindings = record({ value: keyboard.bindings })

          if (!bindings) {
            return invalid({ detail: key })
          }

          for (const [
            id,
            keys,
          ] of Object.entries(bindings)) {
            if (!safeKey({ key: id }) || !KEY_ACTIONS.some(action => action.id === id)) {
              return invalid({ detail: key })
            }

            if (keys === null) {
              delete next.keyboard.bindings[id]
            } else if (Array.isArray(keys) && keys.every(k => typeof k === 'string')) {
              next.keyboard.bindings[id] = keys
            } else {
              return invalid({ detail: key })
            }
          }
        }

        const error = keyboardError({ prefs: next.keyboard })

        if (error) {
          return invalid({ detail: error })
        }

        break
      }
      case 'theme':
        if (value !== 'light' && value !== 'dark' && value !== 'system') {
          return invalid({ detail: key })
        }

        next.theme = value; break
      case 'fontSize': case 'chatFontSize': case 'codeFontSize':
        next[key] = size({
          value,
          min: VIEW_SIZE_LIMITS[key].min,
          max: VIEW_SIZE_LIMITS[key].max,
          key,
        }); break
      case 'defaultHydraWidth': next.defaultHydraWidth = size({
        value,
        ...VIEW_SIZE_LIMITS.hydraWidth,
        key,
      }); break
      case 'hydraWidth': next.hydraWidth = size({
        value,
        ...VIEW_SIZE_LIMITS.hydraWidth,
        key,
      }); break
      case 'panelWidth': next.panelWidth = size({
        value,
        ...VIEW_SIZE_LIMITS.panelWidth,
        key,
      }); break
      case 'cardHeight': next.cardHeight = size({
        value,
        ...VIEW_SIZE_LIMITS.cardHeight,
        key,
      }); break
      case 'panelPlacement':
        if (value !== 'right' && value !== 'inline') {
          return invalid({ detail: key })
        }

        next.panelPlacement = value; break
      case 'cardColors': case 'toolDetails': case 'thinkingDetails': case 'focusMode': case 'lastMessageOnCards':
        if (typeof value !== 'boolean') {
          return invalid({ detail: key })
        }

        next[key] = value; break
      case 'columnWidths': case 'cardHeights': case 'closedCardHeights': case 'defaultColumnWidths': {
        const map = record({ value })

        if (!map) {
          return invalid({ detail: key })
        }

        for (const [
          id,
          n,
        ] of Object.entries(map)) {
          if (!safeKey({ key: id })) {
            return invalid({ detail: key })
          }

          const cardMap = key === 'cardHeights' || key === 'closedCardHeights'

          if (cardMap && !state.cards[id]) {
            return invalid({ detail: id })
          }

          if (key === 'columnWidths' && n !== null && ![
            ...COLUMNS,
            ...hydraColumnIds,
            ...next.customColumns.map(c => c.id),
          ].includes(id as never)) {
            return invalid({ detail: id })
          }

          if (n === null) {
            delete next[key][id]
          } else {
            const limits = cardMap ? VIEW_SIZE_LIMITS.cardHeight : VIEW_SIZE_LIMITS.columnWidth
            next[key][id] = size({
              value: n,
              ...limits,
              key,
            })
          }
        }

        break
      }
      case 'cardTraceOverrides': {
        const map = record({ value })

        if (!map) {
          return invalid({ detail: key })
        }

        for (const [
          id,
          rawOverride,
        ] of Object.entries(map)) {
          if (!safeKey({ key: id }) || !state.cards[id]) {
            return invalid({ detail: id })
          }

          if (rawOverride === null) {
            delete next.cardTraceOverrides[id]; continue
          }

          const override = record({ value: rawOverride })

          if (!override || Object.entries(override).some(([
            k,
            v,
          ]) => ![
            'tools',
            'thinking',
          ].includes(k) || typeof v !== 'boolean')) {
            return invalid({ detail: key })
          }

          next.cardTraceOverrides[id] = {
            ...next.cardTraceOverrides[id],
            ...override,
          }
        }

        break
      }
      case 'customColumns': {
        if (!Array.isArray(value) || value.length > 20) {
          return invalid({ detail: key })
        }

        const ids = new Set<string>()
        next.customColumns = value.map(rawColumn => {
          const c = record({ value: rawColumn })

          if (!c || typeof c.id !== 'string' || !/^custom:[a-z0-9-]{1,60}$/.test(c.id) || ids.has(c.id)
            || typeof c.title !== 'string' || !c.title.trim() || c.title.length > 60 || Object.keys(c).some(k => k !== 'id' && k !== 'title')) {
            return invalid({ detail: key })
          }

          ids.add(c.id)

          return {
            id: c.id as `custom:${string}`,
            title: c.title.trim(),
          }
        })

        // Legacy view edits leave hydra-owned column widths intact.
        for (const id of Object.keys(next.columnWidths)) {
          if (id.startsWith('custom:') && !ids.has(id) && !hydraColumnIds.includes(id as `custom:${string}`)) {
            delete next.columnWidths[id]
          }
        }

        break
      }
      default: return invalid({ detail: key })
    }
  }

  return next
}

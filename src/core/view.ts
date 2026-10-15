import { BoardError, COLUMNS, type BoardState, type ViewPreferences } from './model.ts'
import { DEFAULT_KEYBOARD, KEY_ACTIONS, keyboardError } from './keyboard.ts'

export const DEFAULT_VIEW: ViewPreferences = {
  theme: 'system',
  keyboard: DEFAULT_KEYBOARD,
  fontSize: 14,
  chatFontSize: 16,
  codeFontSize: 13,
  panelPlacement: 'inline',
  panelWidth: 440,
  composerHeight: 180,
  cardHeight: 250,
  cardColors: true,
  toolDetails: false,
  thinkingDetails: false,
  columnWidths: {},
  cardHeights: {},
  cardTraceOverrides: {},
  customColumns: [],
}

export const VIEW_SIZE_LIMITS = {
  panelWidth: { min: 320, max: 720 },
  panelHeight: { min: 280 },
  composerHeight: { min: 140, max: 420 },
  fontSize: { min: 12, max: 20 },
  chatFontSize: { min: 12, max: 22 },
  codeFontSize: { min: 10, max: 20 },
  cardHeight: { min: 200, max: 600 },
  columnWidth: { min: 240, max: 640 },
  cardWidth: { min: 200 },
  columnHeight: { min: 200 },
} as const

export const clampViewSize = ({ value, min, max }: { value: number; min: number; max: number }) =>
  Math.round(Math.max(min, Math.min(max, value)))

const persistedSize = ({ value, fallback, min, max }: {
  value: unknown
  fallback: number
  min: number
  max: number
}) =>
  typeof value === 'number' && Number.isFinite(value) ? clampViewSize({ value, min, max }) : fallback

const persistedMap = ({ values, min, max }: {
  values: Record<string, number> | undefined
  min: number
  max: number
}) =>
  Object.fromEntries(
    Object.entries(values ?? {}).map(([key, value]) =>
      [key, persistedSize({
        value,
        fallback: min,
        min,
        max,
      })]),
  )

// Focus shows only prompts and agent messages: on while a card shows neither tool
// calls nor thinking, by its own override or the board default.
export function traces({ view, card }: { view: ViewPreferences; card: string }) {
  const overrides = view.cardTraceOverrides[card]
  const tools = overrides?.tools ?? view.toolDetails
  const thinking = overrides?.thinking ?? view.thinkingDetails

  return { tools, thinking, focus: !tools && !thinking, overrides }
}

export const viewFor = ({ state }: { state: Pick<BoardState, 'view'> }): ViewPreferences => {
  const view = { ...structuredClone(DEFAULT_VIEW), ...state.view }

  return {
    ...view,
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
    panelWidth: persistedSize(
      {
        value: view.panelWidth,
        fallback: DEFAULT_VIEW.panelWidth,
        min: VIEW_SIZE_LIMITS.panelWidth.min,
        max: VIEW_SIZE_LIMITS.panelWidth.max,
      },
    ),
    composerHeight: persistedSize(
      {
        value: view.composerHeight,
        fallback: DEFAULT_VIEW.composerHeight,
        min: VIEW_SIZE_LIMITS.composerHeight.min,
        max: VIEW_SIZE_LIMITS.composerHeight.max,
      },
    ),
    cardHeight: persistedSize(
      {
        value: view.cardHeight,
        fallback: DEFAULT_VIEW.cardHeight,
        min: VIEW_SIZE_LIMITS.cardHeight.min,
        max: VIEW_SIZE_LIMITS.cardHeight.max,
      },
    ),
    columnWidths: persistedMap(
      {
        values: view.columnWidths,
        min: VIEW_SIZE_LIMITS.columnWidth.min,
        max: VIEW_SIZE_LIMITS.columnWidth.max,
      },
    ),
    cardHeights: persistedMap(
      {
        values: view.cardHeights,
        min: VIEW_SIZE_LIMITS.cardHeight.min,
        max: VIEW_SIZE_LIMITS.cardHeight.max,
      },
    ),
  }
}

const invalid = ({ detail }: { detail: string }): never => {
  throw new BoardError({ message: `invalid view preference: ${detail}`, code: 'VALIDATION_ERROR' })
}

const record = ({ value }: { value: unknown }): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
const safeKey = ({ key }: { key: string }) => !['__proto__', 'prototype', 'constructor'].includes(key)

const size = ({ value, min, max, key }: {
  value: unknown
  min: number
  max: number
  key: string
}) => {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    invalid({ detail: key })
  }

  return value as number
}

// A patch merges maps; null removes an individual override. All callers use this validator.
export function patchView({ state, input: rawInput }: {
  state: BoardState
  input: unknown
}): ViewPreferences {
  const input = record({ value: rawInput })

  if (!input) {
    return invalid({ detail: 'expected an object' })
  }

  const next = structuredClone(viewFor({ state }))
  const boardColumnIds = state.board?.columns.map(c => c.id) ?? []

  for (const [key, value] of Object.entries(input).sort(([a], [b]) => a === 'customColumns' ? -1 : b === 'customColumns' ? 1 : a.localeCompare(b))) {
    switch (key) {
      case 'keyboard': {
        const keyboard = record({ value })

        if (!keyboard || Object.keys(keyboard).some(k => !['characterShortcuts', 'bindings'].includes(k))) {
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

          for (const [id, keys] of Object.entries(bindings)) {
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
      case 'panelWidth': next.panelWidth = size({ value, min: VIEW_SIZE_LIMITS.panelWidth.min, max: VIEW_SIZE_LIMITS.panelWidth.max, key }); break
      case 'composerHeight': next.composerHeight = size({ value, min: VIEW_SIZE_LIMITS.composerHeight.min, max: VIEW_SIZE_LIMITS.composerHeight.max, key }); break
      case 'cardHeight': next.cardHeight = size({ value, min: VIEW_SIZE_LIMITS.cardHeight.min, max: VIEW_SIZE_LIMITS.cardHeight.max, key }); break
      case 'panelPlacement':
        if (value !== 'right' && value !== 'inline') {
          return invalid({ detail: key })
        }

        next.panelPlacement = value; break
      case 'cardColors': case 'toolDetails': case 'thinkingDetails':
        if (typeof value !== 'boolean') {
          return invalid({ detail: key })
        }

        next[key] = value; break
      case 'columnWidths': case 'cardHeights': {
        const map = record({ value })

        if (!map) {
          return invalid({ detail: key })
        }

        for (const [id, n] of Object.entries(map)) {
          if (!safeKey({ key: id })) {
            return invalid({ detail: key })
          }

          if (key === 'cardHeights' && !state.cards[id]) {
            return invalid({ detail: id })
          }

          if (key === 'columnWidths' && ![...COLUMNS, ...boardColumnIds, ...next.customColumns.map(c => c.id)].includes(id as never)) {
            return invalid({ detail: id })
          }

          if (n === null) {
            delete next[key][id]
          } else {
            const limits = key === 'columnWidths' ? VIEW_SIZE_LIMITS.columnWidth : VIEW_SIZE_LIMITS.cardHeight
            next[key][id] = size({ value: n, min: limits.min, max: limits.max, key })
          }
        }

        break
      }
      case 'cardTraceOverrides': {
        const map = record({ value })

        if (!map) {
          return invalid({ detail: key })
        }

        for (const [id, rawOverride] of Object.entries(map)) {
          if (!safeKey({ key: id }) || !state.cards[id]) {
            return invalid({ detail: id })
          }

          if (rawOverride === null) {
            delete next.cardTraceOverrides[id]; continue
          }

          const override = record({ value: rawOverride })

          if (!override || Object.entries(override).some(([k, v]) => !['tools', 'thinking'].includes(k) || typeof v !== 'boolean')) {
            return invalid({ detail: key })
          }

          next.cardTraceOverrides[id] = { ...next.cardTraceOverrides[id], ...override }
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

          return { id: c.id as `custom:${string}`, title: c.title.trim() }
        })

        // Legacy view edits leave board-owned column widths intact.
        for (const id of Object.keys(next.columnWidths)) {
          if (id.startsWith('custom:') && !ids.has(id) && !boardColumnIds.includes(id as `custom:${string}`)) {
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

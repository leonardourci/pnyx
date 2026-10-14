import { BoardError, COLUMNS, type BoardState, type ViewPreferences } from './model.ts'
import { DEFAULT_KEYBOARD, KEY_ACTIONS, keyboardError } from './keyboard.ts'

export const DEFAULT_VIEW: ViewPreferences = {
  keyboard: DEFAULT_KEYBOARD,
  fontSize: 14,
  panelPlacement: 'right',
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
export const viewFor = (state: BoardState): ViewPreferences => ({ ...structuredClone(DEFAULT_VIEW), ...state.view })

const invalid = (key: string): never => {
  throw new BoardError(`invalid view preference: ${key}`, 'VALIDATION_ERROR')
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const safeKey = (key: string) => !['__proto__', 'prototype', 'constructor'].includes(key)

const size = (value: unknown, min: number, max: number, key: string) => {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    invalid(key)
  }

  return value as number
}

// A patch merges maps; null removes an individual override. All callers use this validator.
export function patchView(state: BoardState, input: unknown): ViewPreferences {
  if (!record(input)) {
    return invalid('expected an object')
  }

  const next = structuredClone(viewFor(state))

  for (const [key, value] of Object.entries(input).sort(([a], [b]) => a === 'customColumns' ? -1 : b === 'customColumns' ? 1 : a.localeCompare(b))) {
    switch (key) {
      case 'keyboard': {
        if (!record(value) || Object.keys(value).some(k => !['characterShortcuts', 'bindings'].includes(k))) {
          return invalid(key)
        }

        if (value.characterShortcuts !== undefined) {
          if (typeof value.characterShortcuts !== 'boolean') {
            return invalid(key)
          }

          next.keyboard.characterShortcuts = value.characterShortcuts
        }

        if (value.bindings === null) {
          next.keyboard.bindings = {}
        } else if (value.bindings !== undefined) {
          if (!record(value.bindings)) {
            return invalid(key)
          }

          for (const [id, keys] of Object.entries(value.bindings)) {
            if (!safeKey(id) || !KEY_ACTIONS.some(action => action.id === id)) {
              return invalid(key)
            }

            if (keys === null) {
              delete next.keyboard.bindings[id]
            } else if (Array.isArray(keys) && keys.every(k => typeof k === 'string')) {
              next.keyboard.bindings[id] = keys
            } else {
              return invalid(key)
            }
          }
        }

        const error = keyboardError(next.keyboard)

        if (error) {
          return invalid(error)
        }

        break
      }
      case 'fontSize': next.fontSize = size(value, 12, 20, key); break
      case 'panelWidth': next.panelWidth = size(value, 320, 720, key); break
      case 'composerHeight': next.composerHeight = size(value, 140, 420, key); break
      case 'cardHeight': next.cardHeight = size(value, 200, 600, key); break
      case 'panelPlacement':
        if (value !== 'right' && value !== 'inline') {
          return invalid(key)
        }

        next.panelPlacement = value; break
      case 'cardColors': case 'toolDetails': case 'thinkingDetails':
        if (typeof value !== 'boolean') {
          return invalid(key)
        }

        next[key] = value; break
      case 'columnWidths': case 'cardHeights': {
        if (!record(value)) {
          return invalid(key)
        }

        for (const [id, n] of Object.entries(value)) {
          if (!safeKey(id)) {
            return invalid(key)
          }

          if (key === 'cardHeights' && !state.cards[id]) {
            return invalid(id)
          }

          if (key === 'columnWidths' && ![...COLUMNS, ...next.customColumns.map(c => c.id)].includes(id as never)) {
            return invalid(id)
          }

          if (n === null) {
            delete next[key][id]
          } else {
            next[key][id] = size(n, key === 'columnWidths' ? 240 : 200, key === 'columnWidths' ? 640 : 600, key)
          }
        }

        break
      }
      case 'cardTraceOverrides':
        if (!record(value)) {
          return invalid(key)
        }

        for (const [id, override] of Object.entries(value)) {
          if (!safeKey(id) || !state.cards[id]) {
            return invalid(id)
          }

          if (override === null) {
            delete next.cardTraceOverrides[id]; continue
          }

          if (!record(override) || Object.entries(override).some(([k, v]) => !['tools', 'thinking'].includes(k) || typeof v !== 'boolean')) {
            return invalid(key)
          }

          next.cardTraceOverrides[id] = { ...next.cardTraceOverrides[id], ...override }
        }

        break
      case 'customColumns': {
        if (!Array.isArray(value) || value.length > 20) {
          return invalid(key)
        }

        const ids = new Set<string>()
        next.customColumns = value.map(c => {
          if (!record(c) || typeof c.id !== 'string' || !/^custom:[a-z0-9-]{1,60}$/.test(c.id) || ids.has(c.id)
            || typeof c.title !== 'string' || !c.title.trim() || c.title.length > 60 || Object.keys(c).some(k => k !== 'id' && k !== 'title')) {
            return invalid(key)
          }

          ids.add(c.id)

          return { id: c.id as `custom:${string}`, title: c.title.trim() }
        })

        if (Object.values(state.cards).some(c => c.manualColumn?.startsWith('custom:') && !ids.has(c.manualColumn))) {
          return invalid('column still contains cards')
        }

        break
      }
      default: return invalid(key)
    }
  }

  return next
}

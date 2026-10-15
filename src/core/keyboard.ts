import { matchKeybindingPress, parseKeybinding, type KeybindingPress } from 'tinykeys'

export type KeyScope = 'board' | 'thread' | 'navigation' | 'composer' | 'overlay' | 'hints'
export type KeyPlatform = 'mac' | 'other'
const navigation: KeyScope[] = ['board', 'thread', 'navigation']
const action = (
  { id, label, keys, scopes, repeat = false }: {
    id: string
    label: string
    keys: string[]
    scopes: KeyScope[]
    repeat?: boolean
  },
) => ({ id, label, keys, scopes, repeat })
export const KEY_ACTIONS = [
  action({ id: 'board.up', label: 'Previous card', keys: ['ArrowUp', 'k'], scopes: ['board'], repeat: true }),
  action({ id: 'board.down', label: 'Next card', keys: ['ArrowDown', 'j'], scopes: ['board'], repeat: true }),
  action({ id: 'board.left', label: 'Previous column', keys: ['ArrowLeft', 'h'], scopes: ['board'], repeat: true }),
  action({ id: 'board.right', label: 'Next column', keys: ['ArrowRight', 'l'], scopes: ['board'], repeat: true }),
  action({ id: 'board.first', label: 'First card', keys: ['Home'], scopes: ['board'], repeat: true }),
  action({ id: 'board.last', label: 'Last card', keys: ['End'], scopes: ['board'], repeat: true }),
  action({ id: 'board.open', label: 'Open conversation', keys: ['Enter'], scopes: ['board'] }),
  action({ id: 'thread.up', label: 'Previous message block', keys: ['ArrowUp', 'k'], scopes: ['thread'], repeat: true }),
  action({ id: 'thread.down', label: 'Next message block', keys: ['ArrowDown', 'j'], scopes: ['thread'], repeat: true }),
  action({ id: 'thread.pageUp', label: 'Previous conversation page', keys: ['PageUp'], scopes: ['thread'], repeat: true }),
  action({ id: 'thread.pageDown', label: 'Next conversation page', keys: ['PageDown'], scopes: ['thread'], repeat: true }),
  action({ id: 'thread.first', label: 'First loaded message', keys: ['Home'], scopes: ['thread'], repeat: true }),
  action({ id: 'thread.last', label: 'Latest loaded message', keys: ['End'], scopes: ['thread'], repeat: true }),
  action({ id: 'thread.reply', label: 'Reply at the end of the conversation', keys: ['Enter'], scopes: ['thread'] }),
  action({ id: 'thread.comment', label: 'Comment on selected block', keys: ['c'], scopes: ['thread'] }),
  action({ id: 'reply', label: 'Focus reply composer', keys: ['r'], scopes: ['board', 'thread'] }),
  action({ id: 'send', label: 'Send reply', keys: ['Mod+Enter'], scopes: ['composer'] }),
  action({ id: 'cancel', label: 'Close the current layer', keys: ['Escape'], scopes: [...navigation, 'composer', 'overlay', 'hints'] }),
  action({ id: 'move.left', label: 'Move highlighted left', keys: ['Mod+ArrowLeft'], scopes: ['board'] }),
  action({ id: 'move.right', label: 'Move highlighted right', keys: ['Mod+ArrowRight'], scopes: ['board'] }),
  action({ id: 'move.up', label: 'Move highlighted up', keys: ['Mod+ArrowUp'], scopes: ['board'] }),
  action({ id: 'move.down', label: 'Move highlighted down', keys: ['Mod+ArrowDown'], scopes: ['board'] }),
  action({ id: 'search', label: 'Search history', keys: ['/'], scopes: navigation }),
  action({ id: 'find', label: 'Find in current view', keys: ['Mod+f'], scopes: [...navigation, 'composer'] }),
  action({ id: 'palette', label: 'Focus search', keys: ['Mod+k'], scopes: [...navigation, 'composer'] }),
  action({ id: 'help', label: 'Keyboard help', keys: ['?'], scopes: navigation }),
  action({ id: 'settings', label: 'Open settings', keys: ['Mod+,'], scopes: navigation }),
  action({ id: 'topbar', label: 'Show or hide the top bar', keys: ['Mod+b'], scopes: [...navigation, 'composer'] }),
]
export interface KeyboardPreferences {
  characterShortcuts: boolean
  bindings: Record<string, string[]>
}
export const DEFAULT_KEYBOARD: KeyboardPreferences = { characterShortcuts: true, bindings: {} }
export const bindingsFor = ({ prefs, id }: { prefs: KeyboardPreferences; id: string }) =>
  prefs.bindings[id] ?? KEY_ACTIONS.find(a => a.id === id)?.keys ?? []
const namedKeys = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Enter', 'Escape', 'Backspace', 'Delete', ...Array.from({ length: 12 }, (_, i) => 'F' + (i + 1))])
const modifiers = ['Control', 'Meta', 'Alt', 'Shift']

export function parseBinding({ binding, platform }: {
  binding: string
  platform: KeyPlatform
}): KeybindingPress[] {
  return parseKeybinding(binding.trim().replace(/\s+/g, ' ')
    .replace(/(\$mod|\bMod)(?=\+)/g, platform === 'mac' ? 'Meta' : 'Control')).map(([required, optional, key]) => {
    // Symbols use their logical key on layouts with or without Shift.
    const implicitShift = typeof key === 'string' && key.length === 1 && /[^a-z0-9]/i.test(key) && !required.includes('Shift')

    return [required, implicitShift ? [...optional, 'Shift'] : optional, key]
  })
}

const printable = ({ press }: { press: KeybindingPress }) =>
  typeof press[2] === 'string' && press[2].length === 1 && !press[0].some(m => ['Control', 'Meta', 'Alt'].includes(m))
export const characterBinding = ({ binding, platform }: {
  binding: string
  platform: KeyPlatform
}) =>
  parseBinding({ binding, platform }).some(p => printable({ press: p }))

const samePress = ({ a, b }: { a: KeybindingPress; b: KeybindingPress }) => {
  if (String(a[2]).toLowerCase() !== String(b[2]).toLowerCase()) {
    return false
  }

  return modifiers.every(m =>
    !(a[0].includes(m) && !b[0].includes(m) && !b[1].includes(m))
    && !(b[0].includes(m) && !a[0].includes(m) && !a[1].includes(m)))
}

export function keyboardError({ prefs }: { prefs: KeyboardPreferences }): string | undefined {
  const all: { id: string; binding: string; strokes: KeybindingPress[]; scopes: KeyScope[] }[] = []

  for (const id of Object.keys(prefs.bindings)) {
    if (!KEY_ACTIONS.some(a => a.id === id)) {
      return 'Unknown keyboard action: ' + id
    }
  }

  for (const platform of ['mac', 'other'] as const) {
    all.length = 0

    for (const a of KEY_ACTIONS) {
      const keys = bindingsFor({ prefs, id: a.id })

      if (!Array.isArray(keys) || keys.length > 4) {
        return 'Use at most four bindings for ' + a.label
      }

      for (const binding of keys) {
        if (typeof binding !== 'string' || !binding.trim() || binding.length > 100) {
          return 'Invalid binding for ' + a.label
        }

        let strokes: KeybindingPress[]

        try {
          strokes = parseBinding({ binding, platform })
        } catch {
          return 'Invalid key syntax: ' + binding
        }

        if (strokes.length > 3 || strokes.some(([required, optional, key]) =>
          new Set(required).size !== required.length || required.some(m => !modifiers.includes(m)) || optional.some(m => m !== 'Shift') ||
          typeof key !== 'string' || (!namedKeys.has(key) && ([...key].length !== 1 || /\s/.test(key))))) {
          return 'Use logical keys, modifiers and up to three space-separated keys: ' + binding
        }

        const localFind = a.id === 'find' && strokes.length === 1
          && strokes[0]![0].length === 1 && ['Control', 'Meta'].includes(strokes[0]![0][0]!)
          && String(strokes[0]![2]).toLowerCase() === 'f'

        if (!localFind && strokes.some(([mods, , key]) => (mods.some(m => m === 'Control' || m === 'Meta') && /^(l|t|w|r|f|p|q|n|\+|-|=|0)$/i.test(String(key))) || (mods.includes('Alt') && ['ArrowLeft', 'ArrowRight'].includes(String(key))))) {
          return 'Reserved browser shortcut: ' + binding
        }

        if ((a.id === 'send' || a.id === 'cancel') && strokes.some(p => printable({ press: p }))) {
          return 'Typing must remain literal: ' + a.label + ' needs a non-printing key or a command modifier'
        }

        if (a.id === 'cancel' && strokes.some(([mods, , key]) => !mods.some(m => ['Control', 'Meta', 'Alt'].includes(m)) && key !== 'Escape' && !/^F\d+$/.test(String(key)))) {
          return 'Close the current layer needs Escape, a function key, or a command modifier; keep editing keys available'
        }

        if (a.id === 'send' && strokes.some(([mods]) => !mods.some(m => m === 'Control' || m === 'Meta'))) {
          return 'Send reply needs Mod, Control or Meta; Enter always adds a newline'
        }

        for (const prior of all) {
          if (
            a.scopes.some(s => prior.scopes.includes(s))
            && strokes
              .slice(0, Math.min(strokes.length, prior.strokes.length))
              .every((s, i) => samePress({ a: s, b: prior.strokes[i] }))
          ) {
            return 'Shortcut conflicts with ' + KEY_ACTIONS.find(x => x.id === prior.id)!.label + ': ' + binding
          }
        }

        all.push({ id: a.id, binding, strokes, scopes: a.scopes })
      }
    }
  }
}

export interface KeyInput {
  key: string
  code?: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  repeat?: boolean
  isComposing?: boolean
  defaultPrevented?: boolean
  altGraph?: boolean
}
export interface KeyContext {
  scope: KeyScope
  editing?: boolean
  characterShortcuts: boolean
  platform: KeyPlatform
  now: number
}
export interface KeyProgress {
  candidates: { action: string; binding: string; next: number }[]
  scope: KeyScope
  until: number
}
export const emptyProgress = (): KeyProgress => ({ candidates: [], scope: 'navigation', until: 0 })

export function matchesPress({ event, stroke }: {
  event: KeyInput
  stroke: KeybindingPress
}): boolean {
  const wrapped = { ...event, code: event.code ?? '', getModifierState: (m: string) => ({ Control: !!event.ctrlKey, Meta: !!event.metaKey, Alt: !!event.altKey, Shift: !!event.shiftKey }[m] ?? false) }

  return matchKeybindingPress(wrapped as KeyboardEvent, stroke)
}

export function resolveKey(
  { event, context, prefs, progress = emptyProgress() }: {
    event: KeyInput
    context: KeyContext
    prefs: KeyboardPreferences
    progress?: KeyProgress
  },
): { action?: string; consume: boolean; progress: KeyProgress } {
  const empty = { consume: false, progress: emptyProgress() }

  if (event.defaultPrevented || event.isComposing || event.altGraph || ['Process', 'Dead', 'Unidentified'].includes(event.key)) {
    return empty
  }

  if (modifiers.includes(event.key)) {
    return { consume: false, progress }
  }

  const available = KEY_ACTIONS.filter(a =>
    a.scopes.includes(context.scope)
    && (!context.editing || ['find', 'send', 'palette', 'topbar'].includes(a.id) || (a.id === 'cancel' && context.scope !== 'navigation')))
  const candidates = progress.scope === context.scope && context.now <= progress.until
    ? progress.candidates
    : []
  const pending: KeyProgress['candidates'] = []

  for (const a of available) {
    for (const binding of bindingsFor({ prefs, id: a.id })) {
      const strokes = parseBinding({ binding, platform: context.platform })

      const typesText = strokes.some(p => printable({ press: p }))

      if ((!context.characterShortcuts || context.editing) && typesText) {
        continue
      }

      if (event.repeat && !a.repeat) {
        continue
      }

      const next = candidates.find(c => c.action === a.id && c.binding === binding)?.next ?? 0

      if (!matchesPress({ event, stroke: strokes[next] })) {
        continue
      }

      if (next + 1 === strokes.length) {
        return { action: a.id, consume: true, progress: emptyProgress() }
      }

      pending.push({ action: a.id, binding, next: next + 1 })
    }
  }

  return {
    consume: pending.length > 0,
    progress: { candidates: pending, scope: context.scope, until: context.now + 1500 },
  }
}

export function keyLabel({ keys, platform }: { keys: string[]; platform: KeyPlatform }): string {
  return keys.map(k => k.replace(/Mod\+/g, platform === 'mac' ? '⌘+' : 'Ctrl+').replace(/ArrowUp/g, '↑')
    .replace(/ArrowDown/g, '↓')
    .replace(/ArrowLeft/g, '←')
    .replace(/ArrowRight/g, '→')).join(' / ') || 'Unbound'
}

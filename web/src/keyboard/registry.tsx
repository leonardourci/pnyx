import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react'
import { bindingsFor, characterBinding, emptyProgress, keyLabel, resolveKey, type KeyboardPreferences, type KeyPlatform, type KeyScope } from '../../../src/core/keyboard.ts'

export interface ActionContext { scope: KeyScope; target: HTMLElement }
type Handler = (context: ActionContext) => boolean
interface KeyboardContext {
  prefs: KeyboardPreferences
  platform: KeyPlatform
  label(id: string): string
  handlers: Map<string, Handler>
}
const Context = createContext<KeyboardContext | null>(null)
export const isEditing = (target: HTMLElement) => !!target.closest('input,textarea,[contenteditable]:not([contenteditable=false])')

export function focusElement(selector: string) {
  const element = document.querySelector<HTMLElement>(selector)
  element?.focus({ preventScroll: true }); element?.scrollIntoView({ block: 'nearest', inline: 'nearest' })

  return !!element && document.activeElement === element
}

export function KeyboardProvider({
  prefs,
  onAction,
  leaveField,
  hints,
  hintKey,
  children,
}: {
  prefs: KeyboardPreferences
  onAction(id: string, context: ActionContext): boolean
  leaveField(): void
  hints: boolean
  hintKey(event: KeyboardEvent): boolean
  children: ReactNode
}) {
  const platform: KeyPlatform = /Mac|iPhone|iPad/.test(navigator.platform) ? 'mac' : 'other'
  const handlers = useRef(new Map<string, Handler>())
  const current = useRef({ prefs, onAction, leaveField, hints, hintKey })
  current.current = { prefs, onAction, leaveField, hints, hintKey }
  useEffect(() => {
    let progress = emptyProgress()

    const keydown = (event: KeyboardEvent) => {
      const { prefs, onAction, leaveField, hints, hintKey } = current.current
      const target = event.target instanceof HTMLElement ? event.target : document.body

      if (!hints && target instanceof HTMLInputElement && target.type === 'search' && event.key === 'Escape') {
        if (event.isComposing) {
          return
        }

        if (!target.value) {
          target.blur(); leaveField()

          return
        }

        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(target, '')
        target.dispatchEvent(new Event('input', { bubbles: true }))

        return
      }

      const overlay = target.closest('[data-key-scope=overlay]')
      const scope = hints ? 'hints' : overlay ? 'overlay' : (target.dataset.keyScope ?? 'navigation') as KeyScope

      // These controls own their standard navigation and selection keys.
      if (!hints && !event.ctrlKey && !event.metaKey && !event.altKey && target.closest('[role=combobox],[role=listbox],[role=separator]') && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' '].includes(event.key)) {
        return
      }

      const result = resolveKey({ event: { key: event.key, code: event.code, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, shiftKey: event.shiftKey, repeat: event.repeat, defaultPrevented: event.defaultPrevented, isComposing: event.isComposing, altGraph: event.getModifierState('AltGraph') }, context: { scope, editing: isEditing(target), platform, characterShortcuts: prefs.characterShortcuts, now: performance.now() }, prefs, progress })
      progress = result.progress

      if (result.action) {
        const context = { scope, target }

        if (handlers.current.get(result.action)?.(context) || onAction(result.action, context)) {
          event.preventDefault()
        }
      } else if (result.consume) {
        event.preventDefault()
      } else if (hints && !event.defaultPrevented && !event.isComposing && hintKey(event)) {
        event.preventDefault()
      }
    }

    const reset = () => {
      progress = emptyProgress()
    }

    window.addEventListener('keydown', keydown)
    window.addEventListener('blur', reset); document.addEventListener('focusin', reset)

    return () => {
      window.removeEventListener('keydown', keydown); window.removeEventListener('blur', reset); document.removeEventListener('focusin', reset)
    }
  }, [platform])

  return (
    <Context
      value={{
        prefs,
        platform,
        handlers: handlers.current,
        label: id => keyLabel(
          {
            keys: bindingsFor({ prefs, id }).filter(
              binding => prefs.characterShortcuts || !characterBinding({ binding, platform }),
            ),
            platform,
          },
        ),
      }}
    >
      {children}
    </Context>
  )
}

export function useKeyboard() {
  const value = useContext(Context)

  if (!value) {
    throw new Error('KeyboardProvider is required')
  }

  return value
}

export function useKeyAction(id: string, handler: Handler) {
  const { handlers } = useKeyboard(), current = useRef(handler); current.current = handler
  useEffect(() => {
    const run: Handler = context => current.current(context); handlers.set(id, run)

    return () => {
      if (handlers.get(id) === run) {
        handlers.delete(id)
      }
    }
  }, [id, handlers])
}

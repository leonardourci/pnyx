import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react'
import { CARET_HOST, CARET_KEY } from '#web-hydra/caret.ts'
import { composing } from '#web-shared/ime.ts'
import { bindingsFor, characterBinding, emptyProgress, keyLabel, resolveKey, type KeyboardPreferences, type KeyPlatform, type KeyScope } from '#preferences/keyboard.ts'

export interface ActionContext {
  scope: KeyScope
  target: HTMLElement
}
type Handler = ({ context }: { context: ActionContext }) => boolean
interface KeyboardContext {
  prefs: KeyboardPreferences
  platform: KeyPlatform
  label({ id }: { id: string }): string
  handlers: Map<string, Set<Handler>>
}
const Context = createContext<KeyboardContext | null>(null)

// The caret host is editable only to draw a caret, so its keys are not typing.
export const isEditing = ({ target }: { target: Element }) => {
  const field = target.closest('input,textarea,[contenteditable]:not([contenteditable=false])')

  return !!field && !field.hasAttribute(CARET_HOST)
}

export function focusElement({ selector }: { selector: string }) {
  const element = document.querySelector<HTMLElement>(selector)
  element?.focus({ preventScroll: true }); element?.scrollIntoView({
    block: 'nearest',
    inline: 'nearest',
    ...(element.closest('.kanban')
      ? { behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' } as const
      : {}),
  })

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
  onAction({
    id,
    context,
  }: {
    id: string
    context: ActionContext
  }): boolean
  leaveField(): void
  hints: boolean
  hintKey({ event }: { event: KeyboardEvent }): boolean
  children: ReactNode
}) {
  const platform: KeyPlatform = /Mac|iPhone|iPad/.test(navigator.platform) ? 'mac' : 'other'
  const handlers = useRef(new Map<string, Set<Handler>>())
  const current = useRef({
    prefs,
    onAction,
    leaveField,
    hints,
    hintKey,
  })
  current.current = {
    prefs,
    onAction,
    leaveField,
    hints,
    hintKey,
  }
  useEffect(
    () => {
      let progress = emptyProgress()

      const keydown = (event: KeyboardEvent) => {
        const {
          prefs,
          onAction,
          leaveField,
          hints,
          hintKey,
        } = current.current
        const target = event.target instanceof HTMLElement ? event.target : document.body

        if (!hints && target instanceof HTMLInputElement && target.type === 'search' && event.key === 'Escape') {
          if (composing({ event })) {
            return
          }

          if (!target.value) {
            target.blur(); leaveField()

            return
          }

          Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            'value',
          )!.set!.call(
            target,
            '',
          )
          target.dispatchEvent(new Event(
            'input',
            { bubbles: true },
          ))

          return
        }

        const overlay = target.closest('[data-key-scope=overlay]')
        // Message blocks, comments and buttons inside the conversation share its scope.
        const scope = hints ? 'hints' : overlay ? 'overlay' : (target.closest<HTMLElement>('[data-key-scope]')?.dataset.keyScope ?? 'navigation') as KeyScope
        // These controls own their standard navigation and selection keys; buttons and
        // links and disclosures in the conversation keep Enter.
        const owned = target.closest('[role=combobox],[role=listbox],[role=separator]')
        || (scope === 'thread' && event.key === 'Enter' && target.closest('button,a,summary'))

        if (!hints && target.hasAttribute(CARET_HOST) && CARET_KEY.test(event.key)) {
          return
        }

        if (!hints && !event.ctrlKey && !event.metaKey && !event.altKey && owned && [
          'ArrowUp',
          'ArrowDown',
          'ArrowLeft',
          'ArrowRight',
          'Home',
          'End',
          'Enter',
          ' ',
        ].includes(event.key)) {
          return
        }

        const result = resolveKey({
          event: {
            key: event.key,
            code: event.code,
            ctrlKey: event.ctrlKey,
            metaKey: event.metaKey,
            altKey: event.altKey,
            shiftKey: event.shiftKey,
            repeat: event.repeat,
            defaultPrevented: event.defaultPrevented,
            isComposing: composing({ event }),
            altGraph: event.getModifierState('AltGraph'),
          },
          context: {
            scope,
            editing: isEditing({ target }),
            platform,
            characterShortcuts: prefs.characterShortcuts,
            now: performance.now(),
          },
          prefs,
          progress,
        })
        progress = result.progress

        if (result.action) {
          const context = {
            scope,
            target,
          }

          const handled = [...(handlers.current.get(result.action) ?? [])].reverse()
            .some(run => run({ context }))

          if (handled || onAction({
            id: result.action,
            context,
          })) {
            event.preventDefault()
          }
        } else if (result.consume) {
          event.preventDefault()
        } else if (hints && !event.defaultPrevented && !event.isComposing && hintKey({ event })) {
          event.preventDefault()
        }
      }

      const reset = () => {
        progress = emptyProgress()
      }

      window.addEventListener(
        'keydown',
        keydown,
      )
      window.addEventListener(
        'blur',
        reset,
      ); document.addEventListener(
        'focusin',
        reset,
      )

      return () => {
        window.removeEventListener(
          'keydown',
          keydown,
        ); window.removeEventListener(
          'blur',
          reset,
        ); document.removeEventListener(
          'focusin',
          reset,
        )
      }
    },
    [platform],
  )

  return (
    <Context
      value={{
        prefs,
        platform,
        handlers: handlers.current,
        label: ({ id }) => keyLabel(
          {
            keys: bindingsFor({
              prefs,
              id,
            }).filter(
              binding => prefs.characterShortcuts || !characterBinding({
                binding,
                platform,
              }),
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

export function useKeyAction({
  id,
  handler,
}: {
  id: string
  handler: Handler
}) {
  const { handlers } = useKeyboard(), current = useRef(handler); current.current = handler
  useEffect(
    () => {
      const run: Handler = ({ context }) => current.current({ context })
      const registered = handlers.get(id) ?? new Set<Handler>()
      registered.add(run); handlers.set(
        id,
        registered,
      )

      return () => {
        registered.delete(run)

        if (!registered.size) {
          handlers.delete(id)
        }
      }
    },
    [
      id,
      handlers,
    ],
  )
}

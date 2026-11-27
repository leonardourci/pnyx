import { useEffect } from 'react'
import { focusAtEnd } from './composer-editable.ts'

const APPLE_PLATFORM = /Mac|iPhone|iPad/.test(navigator.platform)
const COMPOSER = '.composer .composer-text'

export const chatAround = ({ from }: { from: Element | null }) => from?.closest('.chat-frame') ?? null

const chatComposer = ({ from }: { from: Element | null }) =>
  chatAround({ from })?.querySelector<HTMLElement>(COMPOSER) ?? null

const shownTitanComposer = ({ titanId }: { titanId: string }) =>
  document.querySelector<HTMLElement>(`[data-titan-workspace="${CSS.escape(titanId)}"] .titan-chat ${COMPOSER}`)

export function focusChatComposer({ from }: { from: Element | null }) {
  const composer = chatComposer({ from })

  if (composer) {
    focusAtEnd({ field: composer })
  }
}

const isComposerShortcut = ({ event }: { event: KeyboardEvent }) => {
  const appleCommand = event.metaKey && !event.ctrlKey
  const controlCommand = event.ctrlKey && !event.metaKey
  const commandKey = APPLE_PLATFORM ? appleCommand : controlCommand
  const otherModifier = event.shiftKey || event.altKey
  const handled = event.isComposing || event.defaultPrevented

  return commandKey && !otherModifier && !handled && event.key.toLowerCase() === 'l'
}

export function useComposerShortcut({ titanId }: { titanId: string }) {
  useEffect(
    () => {
      const focusComposer = (event: KeyboardEvent) => {
        if (!isComposerShortcut({ event })) {
          return
        }

        const focusedChatComposer = chatComposer({ from: document.activeElement })
        const composer = focusedChatComposer ?? shownTitanComposer({ titanId })

        if (!composer) {
          return
        }

        focusAtEnd({ field: composer })
        const composerTookFocus = document.activeElement === composer

        if (composerTookFocus) {
          event.preventDefault()
        }
      }

      window.addEventListener(
        'keydown',
        focusComposer,
      )

      return () => window.removeEventListener(
        'keydown',
        focusComposer,
      )
    },
    [titanId],
  )
}

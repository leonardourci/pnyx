import { useEffect } from 'react'

const APPLE_PLATFORM = /Mac|iPhone|iPad/.test(navigator.platform)
const COMPOSER = '.composer textarea'

const chatComposer = ({ from }: { from: Element | null }) =>
  from?.closest('.detail, .chat-frame')?.querySelector<HTMLTextAreaElement>(COMPOSER) ?? null

const shownTitanComposer = ({ hydraId }: { hydraId: string }) =>
  document.querySelector<HTMLTextAreaElement>(`[data-hydra-workspace="${CSS.escape(hydraId)}"] .hydra-chat ${COMPOSER}`)

const focusAtEnd = ({ composer }: { composer: HTMLTextAreaElement }) => {
  composer.focus()
  composer.setSelectionRange(
    composer.value.length,
    composer.value.length,
  )
}

export function focusChatComposer({ from }: { from: Element | null }) {
  const composer = chatComposer({ from })

  if (composer) {
    focusAtEnd({ composer })
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

export function useComposerShortcut({ hydraId }: { hydraId: string }) {
  useEffect(
    () => {
      const focusComposer = (event: KeyboardEvent) => {
        if (!isComposerShortcut({ event })) {
          return
        }

        const focusedChatComposer = chatComposer({ from: document.activeElement })
        const composer = focusedChatComposer ?? shownTitanComposer({ hydraId })

        if (!composer) {
          return
        }

        focusAtEnd({ composer })
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
    [hydraId],
  )
}

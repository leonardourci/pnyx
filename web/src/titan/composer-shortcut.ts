import { useEffect } from 'react'

const MAC = /Mac|iPhone|iPad/.test(navigator.platform)

// Mod+L moves focus to the composer of the chat it is pressed in, or else to the shown Titan's.
export function useComposerShortcut({ hydraId }: { hydraId: string }) {
  useEffect(
    () => {
      const focusComposer = (event: KeyboardEvent) => {
        const mod = MAC ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey

        if (!mod || event.shiftKey || event.altKey || event.isComposing || event.defaultPrevented
          || event.key.toLowerCase() !== 'l') {
          return
        }

        const composer = document.activeElement?.closest('.detail, .chat-frame')
          ?.querySelector<HTMLTextAreaElement>('.composer textarea')
          ?? document.querySelector<HTMLTextAreaElement>(`[data-hydra-workspace="${CSS.escape(hydraId)}"] .hydra-chat .composer textarea`)

        if (!composer) {
          return
        }

        event.preventDefault()
        composer.focus()
        composer.setSelectionRange(
          composer.value.length,
          composer.value.length,
        )
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

import { useEffect } from 'react'
import { applyRuntimeStyle } from '#web-shared/ui/runtime-style.ts'
import type { ViewPreferences } from '#preferences/model.ts'

export function useViewTheme({
  view,
  active = true,
}: {
  view: ViewPreferences
  active?: boolean
}) {
  useEffect(
    () => {
      if (!active) {
        return
      }

      const root = document.documentElement, dark = matchMedia('(prefers-color-scheme: dark)')
      applyRuntimeStyle({
        element: root,
        values: {
          uiFont: `${view.fontSize}px`,
          chatFont: `${view.chatFontSize}px`,
          codeFont: `${view.codeFontSize}px`,
        },
      })

      const apply = () => {
        root.dataset.theme = view.theme === 'system' ? (dark.matches ? 'dark' : 'light') : view.theme
      }

      apply(); dark.addEventListener(
        'change',
        apply,
      )

      return () => dark.removeEventListener(
        'change',
        apply,
      )
    },
    [
      view.theme,
      view.fontSize,
      view.chatFontSize,
      view.codeFontSize,
      active,
    ],
  )
}

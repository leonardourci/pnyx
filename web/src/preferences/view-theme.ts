import { useEffect } from 'react'
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
      active,
    ],
  )
}

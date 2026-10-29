import { useEffect } from 'react'
import { HYDRA_MARK } from '#hydra/hydra-names.ts'
import { identityFile } from '#web-shared/ui/icon.tsx'

const BLACK_FILL = /fill=(["'])#000\1/g

// The tab shows the open Hydra's icon, drawn in the theme's gold so it reads on light and dark tab bars.
export function useHydraFavicon({ icon = HYDRA_MARK }: { icon?: string }) {
  useEffect(
    () => {
      const file = identityFile({ name: icon })

      if (!file) {
        return
      }

      let cancelled = false
      // A tab icon that cannot load keeps Pnyx's own, so its failure is safe to drop.
      void fetch(file).then(response => response.text())
        .then(svg => {
          if (cancelled) {
            return
          }

          const gold = getComputedStyle(document.documentElement).getPropertyValue('--color-gold')
            .trim()
          const href = `data:image/svg+xml,${encodeURIComponent(svg.replace(
            BLACK_FILL,
            `fill="${gold}"`,
          ))}`

          for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel=icon]')) {
            link.type = 'image/svg+xml'
            link.href = href
          }
        })
        .catch(() => {})

      return () => {
        cancelled = true
      }
    },
    [icon],
  )
}

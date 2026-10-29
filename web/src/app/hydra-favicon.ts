import { useEffect } from 'react'
import { HYDRA_MARK } from '#hydra/hydra-names.ts'
import { identityGlyph } from '#web-shared/ui/icon.tsx'

// The tab shows the open Hydra's icon, drawn in the theme's gold so it reads on light and dark tab bars.
export function useHydraFavicon({ icon = HYDRA_MARK }: { icon?: string }) {
  useEffect(
    () => {
      const glyph = identityGlyph({ name: icon })

      if (!glyph) {
        return
      }

      const gold = getComputedStyle(document.documentElement).getPropertyValue('--color-gold')
        .trim()
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path fill="${gold}" d="${glyph.path}"/></svg>`
      const href = `data:image/svg+xml,${encodeURIComponent(svg)}`

      for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel=icon]')) {
        link.type = 'image/svg+xml'
        link.href = href
      }
    },
    [icon],
  )
}

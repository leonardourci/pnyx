import { useEffect } from 'react'
import { TITAN_MARK } from '#titan/titan-names.ts'
import { identityGlyph } from '#web-shared/icons.tsx'

// The tab shows the open Titan's icon, drawn in the theme's gold so it reads on light and dark tab bars.
export function useTitanFavicon({ icon = TITAN_MARK }: { icon?: string }) {
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

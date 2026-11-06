import { useEffect,useLayoutEffect,useRef } from 'react'

// Keep each tab's view across reloads and newly served builds.
export type Restore = {
  selected?: string | null
  expanded?: string[]
  revealed?: {
    scope: string
    ids: string[]
  }
  page?: string
  panel?: boolean
  drafts?: Record<string, string>
  scroll?: Record<string, [number, number]>
}

export function restoreView({ key }: { key: string }): Restore {
  try {
    return JSON.parse(sessionStorage.getItem(key) ?? '{}') as Restore
  } catch {
    return {}
  }
}

export const scrollers = () => [...document.querySelectorAll<HTMLElement>('.kanban, [data-column] > .column-cards')]
  .map(el => [
    el.closest('[data-column]')?.getAttribute('data-column') ?? 'kanban',
    el,
  ] as const)

export const hydraViews = new Map<string, Restore>()

export function persistView({
  key,
  viewKey,
  value,
}: {
  key: string
  viewKey?: string
  value: Restore
}) {
  const restored: Restore = {
    ...value,
    scroll: Object.fromEntries(scrollers().map(([
      key,
      el,
    ]) => [
      key,
      [
        el.scrollLeft,
        el.scrollTop,
      ],
    ])),
  }

  if (viewKey !== undefined) {
    hydraViews.set(
      viewKey,
      restored,
    )
  }

  try {
    sessionStorage.setItem(
      key,
      JSON.stringify(restored),
    )
  } catch { /* The in-memory view preserves drafts when storage is blocked. */ }
}

export function usePersistView({
  viewKey,
  key,
  selected,
  expanded,
  revealed,
  page,
  panel,
  drafts,
  scroll,
  seq,
}: Restore & {
  viewKey: string
  key: string
  seq: number
}) {
  useLayoutEffect(
    () => () => {
      persistView({
        key: key,
        viewKey: viewKey,
        value: {
          selected,
          expanded,
          revealed,
          page,
          panel,
          drafts,
        },
      })
    },
    [
      viewKey,
      selected,
      expanded,
      revealed,
      page,
      panel,
      drafts,
      key,
    ],
  )
  const pendingScroll = useRef(scroll)
  useEffect(
    () => {
      const keep = () => {
        persistView({
          key: key,
          value: {
            selected,
            expanded,
            revealed,
            page,
            panel,
            drafts,
          },
        })
      }

      addEventListener(
        'pagehide',
        keep,
      )

      return () => removeEventListener(
        'pagehide',
        keep,
      )
    },
    [
      selected,
      expanded,
      revealed,
      page,
      panel,
      drafts,
      key,
    ],
  )
  useEffect(
    () => {
      const scroll = pendingScroll.current

      if (scroll && seq > 0) {
        pendingScroll.current = undefined
        requestAnimationFrame(() => {
          for (const [
            key,
            el,
          ] of scrollers()) {
            const [
              left,
              top,
            ] = scroll[key] ?? [
              0,
              0,
            ]
            el.scrollTo({
              left,
              top,
              behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
            })
          }
        })
      }
    },
    [seq],
  )
}

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
  drafts?: Record<string, string>
  scroll?: Record<string, [number, number]>
}

// What the open Titan shows: its page, the selected and opened cards and the revealed ones.
export type PageView = {
  page: string
  selected: string | null
  expanded: string[]
  revealed: NonNullable<Restore['revealed']>
}

// The view a Titan opens with: the one it saved, unless its link opens a project or settings.
export function openingView({
  restored,
  titanId,
}: {
  restored: Restore
  titanId: string
}): PageView {
  const search = new URLSearchParams(location.search)
  const task = location.pathname === `/hydra/${encodeURIComponent(titanId)}/` ? search.get('task') : null
  const openProject = search.has('open-project')
  const opened = restored.expanded ?? (restored.selected ? [restored.selected] : [])
  const lastOpened = restored.expanded?.at(-1) ?? null

  return {
    page: 'hydra',
    selected: task ?? (openProject ? null : restored.selected ?? lastOpened),
    expanded: openProject ? [] : opened,
    revealed: restored.revealed ?? {
      scope: '',
      ids: [],
    },
  }
}

// Showing the page already shown keeps the view, so the board does not redraw.
export function showingPage({
  view,
  page,
}: {
  view: PageView
  page: string
}): PageView {
  return view.page === page ? view : {
    ...view,
    page,
  }
}

export function restoreView({ key }: { key: string }): Restore {
  try {
    return JSON.parse(sessionStorage.getItem(key) ?? '{}') as Restore
  } catch {
    return {}
  }
}

const workspaceElement = ({ workspace }: { workspace: string }) =>
  document.querySelector<HTMLElement>(`[data-hydra-workspace="${CSS.escape(workspace)}"]`)

export const hydraViews = new Map<string, Restore>()

function persistView({
  key,
  viewKey,
  value,
}: {
  key: string
  viewKey?: string
  value: Restore
}) {
  const restored: Restore = {
    ...restoreView({ key }),
    ...value,
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
  } catch {
    // Storage full or blocked: the open tab keeps its in-memory view; a reload starts fresh.
  }
}

export function usePersistView({
  workspace,
  viewKey,
  key,
  selected,
  expanded,
  revealed,
  page,
  drafts,
  scroll,
  seq,
}: Restore & {
  viewKey: string
  workspace: string
  key: string
  seq: number
}) {
  const positions = useRef(scroll ?? {})
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
          drafts,
          scroll: positions.current,
        },
      })
    },
    [
      viewKey,
      selected,
      expanded,
      revealed,
      page,
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
            drafts,
            scroll: positions.current,
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
      drafts,
      key,
    ],
  )
  useEffect(
    () => {
      const group = workspaceElement({ workspace })
      const axis = group?.closest<HTMLElement>('.workspace-axis')

      if (!axis || !group) {
        return
      }

      let frame = 0

      const keep = () => {
        if (group.dataset.active !== 'true') {
          return
        }

        const offset = axis.scrollLeft - Number(group.dataset.axisOffset ?? axis.scrollLeft)
        const maximum = Number(group.dataset.axisRange ?? 0)

        if (offset < 0 || offset > maximum) {
          return
        }

        positions.current = {
          ...positions.current,
          workspaceAxis: [
            offset,
            0,
          ],
        }

        if (!frame) {
          frame = requestAnimationFrame(() => {
            frame = 0
            const value = restoreView({ key })
            persistView({
              key,
              value: {
                ...value,
                scroll: positions.current,
              },
            })
          })
        }
      }

      axis.addEventListener(
        'scroll',
        keep,
        { passive: true },
      )

      return () => {
        axis.removeEventListener(
          'scroll',
          keep,
        )
        cancelAnimationFrame(frame)
      }
    },
    [
      workspace,
      key,
    ],
  )

  useEffect(
    () => {
      const scroll = pendingScroll.current

      if (!scroll || seq <= 0) {
        return
      }

      pendingScroll.current = undefined
      requestAnimationFrame(() => {
        const group = workspaceElement({ workspace })
        const axis = group?.closest<HTMLElement>('.workspace-axis')
        const offset = scroll.workspaceAxis

        if (offset && group?.dataset.active === 'true' && axis) {
          axis.scrollTo({
            left: Number(group.dataset.axisOffset ?? 0) + Math.max(
              0,
              offset[0],
            ),
            behavior: 'instant',
          })
        }
      })
    },
    [seq],
  )
}

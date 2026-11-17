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

// What the open Hydra shows: its page, the selected and opened cards and the revealed ones.
export type PageView = {
  page: string
  selected: string | null
  expanded: string[]
  revealed: NonNullable<Restore['revealed']>
}

// The view a Hydra opens with: the one it saved, unless its link opens a project or settings.
export function openingView({
  restored,
  hydraId,
}: {
  restored: Restore
  hydraId: string
}): PageView {
  const search = new URLSearchParams(location.search)
  const task = location.pathname === `/hydra/${encodeURIComponent(hydraId)}/` ? search.get('task') : null
  const openProject = search.has('open-project')
  const opened = restored.expanded ?? (restored.selected ? [restored.selected] : [])
  const lastOpened = restored.expanded?.at(-1) ?? null

  return {
    page: 'hydra',
    selected: task ?? (openProject ? null : restored.selected ?? lastOpened),
    expanded: task ? [
      ...new Set([
        ...opened,
        task,
      ]),
    ] : openProject ? [] : opened,
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

const scrollers = ({ workspace }: { workspace: string }) =>
  [...(workspaceElement({ workspace })?.querySelectorAll<HTMLElement>('.column-cards') ?? [])]
    .map(element => [
      element.closest('[data-column]')!.getAttribute('data-column')!,
      element,
    ] as const)

export const hydraViews = new Map<string, Restore>()

function persistView({
  workspace,
  keepAxis = false,
  key,
  viewKey,
  value,
}: {
  key: string
  workspace: string
  keepAxis?: boolean
  viewKey?: string
  value: Restore
}) {
  const restored: Restore = {
    ...value,
    scroll: Object.fromEntries(scrollers({ workspace }).map(([
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

  const group = workspaceElement({ workspace })
  const axis = group?.closest<HTMLElement>('.workspace-axis')
  const oldAxis = restoreView({ key }).scroll?.workspaceAxis

  if (oldAxis) {
    restored.scroll!.workspaceAxis = oldAxis
  }

  if (keepAxis && group?.dataset.active === 'true' && axis) {
    const padding = parseFloat(getComputedStyle(axis).scrollPaddingLeft) || 0
    restored.scroll!.workspaceAxis = [
      axis.getBoundingClientRect().left + padding - group.getBoundingClientRect().left,
      0,
    ]
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
  useLayoutEffect(
    () => () => {
      persistView({
        workspace,
        key: key,
        viewKey: viewKey,
        value: {
          selected,
          expanded,
          revealed,
          page,
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
      drafts,
      key,
    ],
  )
  const pendingScroll = useRef(scroll)
  useEffect(
    () => {
      const keep = () => {
        persistView({
          workspace,
          keepAxis: true,
          key: key,
          value: {
            selected,
            expanded,
            revealed,
            page,
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
          const group = workspaceElement({ workspace })
          const axis = group?.closest<HTMLElement>('.workspace-axis')
          const offset = scroll.workspaceAxis

          if (offset && group?.dataset.active === 'true' && axis) {
            const padding = parseFloat(getComputedStyle(axis).scrollPaddingLeft) || 0
            axis.scrollTo({
              left: axis.scrollLeft + group.getBoundingClientRect().left
              - axis.getBoundingClientRect().left - padding + offset[0],
              behavior: 'instant',
            })
          }

          for (const [
            key,
            el,
          ] of scrollers({ workspace })) {
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

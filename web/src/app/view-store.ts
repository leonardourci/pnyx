import { createStore, type StoreApi } from 'zustand'
import type { Restore } from './restore.ts'

type HydraView = {
  page: string
  panel: boolean
  selected: string | null
  expanded: string[]
  revealed: NonNullable<Restore['revealed']>
}

export type HydraViewStore = StoreApi<HydraView>

export function createHydraView({ restored }: { restored: Restore }): HydraViewStore {
  const search = new URLSearchParams(location.search)
  const openProject = search.has('open-project')
  const opened = restored.expanded ?? (restored.selected ? [restored.selected] : [])
  const lastOpened = restored.expanded?.at(-1) ?? null

  return createStore<HydraView>()(() => ({
    page: search.has('settings') || restored.page === 'settings' ? 'settings' : 'hydra',
    panel: restored.panel ?? true,
    selected: openProject ? null : restored.selected ?? lastOpened,
    expanded: openProject ? [] : opened,
    revealed: restored.revealed ?? {
      scope: '',
      ids: [],
    },
  }))
}

// Showing the page already shown changes nothing, so the board does not redraw.
export function showPage({
  view,
  page,
}: {
  view: HydraViewStore
  page: string
}) {
  if (view.getState().page !== page) {
    view.setState({ page })
  }
}

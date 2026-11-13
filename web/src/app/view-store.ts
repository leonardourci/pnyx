import { createStore, type StoreApi } from 'zustand'
import type { Restore } from './restore.ts'

export type Revealed = {
  scope: string
  ids: string[]
}

// What the open Hydra shows: the page, the panel, and the cards selected, opened and revealed.
export type HydraView = {
  page: string
  panel: boolean
  selected: string | null
  expanded: string[]
  revealed: Revealed
}

export type HydraViewStore = StoreApi<HydraView>

export function createHydraView({ restored }: { restored: Restore }): HydraViewStore {
  const search = new URLSearchParams(location.search)
  const openProject = search.has('open-project')
  const opened = restored.expanded ?? (restored.selected ? [restored.selected] : [])

  return createStore<HydraView>()(() => ({
    page: search.has('settings') || restored.page === 'settings' ? 'settings' : 'hydra',
    panel: restored.panel ?? true,
    selected: openProject ? null : restored.selected ?? restored.expanded?.at(-1) ?? null,
    expanded: openProject ? [] : opened,
    revealed: restored.revealed ?? {
      scope: '',
      ids: [],
    },
  }))
}

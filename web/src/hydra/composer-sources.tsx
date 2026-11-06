import type { HydraState } from '#app/model.ts'
import { hydraConfig } from '#hydra/config.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import type { Catalog } from '#hydra/transcripts-catalog.ts'
import type { HydraProject } from '#projects/model.ts'
import type { HydraColumn } from '#tasks/columns-model.ts'
import type { Card,SavedLabelColor } from '#tasks/model.ts'
import type { Command } from '#web-app/connection.ts'
import type { TaskReferenceData } from '#web-tasks/task-reference.tsx'
import { harnessOf } from '#workers/providers.ts'
import { createContext,useCallback,useContext,useMemo,useRef,useState,type ReactNode } from 'react'
import { useSkillsCatalog } from './skills-catalog.ts'

// What every composer field offers to mention, open and invoke; the app provides it once.
export interface ComposerSources {
  cards: Card[]
  projects: HydraProject[]
  columns: HydraColumn[]
  taskReferences: Record<string, TaskReferenceData>
  openTask({ id }: { id: string }): void
  catalog: Catalog | null
  // A field asks for the skills catalog while its / menu is open.
  catalogOpen({ open }: { open: boolean }): void
  labelColors?: SavedLabelColor[]
  // Projects of the owner's other Hydras, offered under Folders in the @ picker.
  otherProjects: {
    name: string
    path: string
    hydra: string
  }[]
  notify({ text }: { text: string }): void
}

const Sources = createContext<ComposerSources | null>(null)

export function ComposerSourcesProvider({
  sources,
  children,
}: {
  sources: ComposerSources
  children: ReactNode
}) {
  return <Sources.Provider value={sources}>{children}</Sources.Provider>
}

export function useComposerSources() {
  const sources = useContext(Sources)

  if (!sources) {
    throw new Error('A composer field needs a ComposerSourcesProvider above it.')
  }

  return sources
}

// Every composer field in a Hydra mentions its tasks, projects and columns and offers Hydra's skills.
export function HydraComposerSources({
  state,
  command,
  connected,
  references,
  openTask,
  notify,
  otherProjects,
  children,
}: {
  state: HydraState
  command: Command
  connected: boolean
  references: Record<string, TaskReferenceData>
  openTask({ id }: { id: string }): void
  notify({ text }: { text: string }): void
  otherProjects: ComposerSources['otherProjects']
  children: ReactNode
}) {
  const config = hydraConfig({ state }), card = state.cards[HYDRA_CARD]
  const [
    open,
    setOpen,
  ] = useState(false)
  // Several fields can have their / menu open at once; the catalog refreshes while any does.
  const openMenus = useRef(0)
  const catalogOpen = useCallback(
    ({ open }: { open: boolean }) => {
      openMenus.current += open ? 1 : -1
      setOpen(openMenus.current > 0)
    },
    [],
  )
  const receiving = config.hydra.agent?.harness ?? card?.agent?.provider ?? 'claude'
  const catalog = useSkillsCatalog({
    identity: JSON.stringify([
      HYDRA_CARD,
      card?.agent?.provider,
      card?.agent?.cwd,
      card?.agent?.sessionId,
      harnessOf({ provider: receiving }),
    ]),
    card: HYDRA_CARD,
    provider: receiving,
    command,
    connected,
    open,
  })
  const cards = useMemo(
    () => Object.values(state.cards),
    [state.cards],
  )

  return (
    <ComposerSourcesProvider
      sources={{
        cards,
        projects: state.projects ?? [],
        columns: config.columns,
        taskReferences: references,
        openTask,
        catalog,
        catalogOpen,
        labelColors: state.labelColors,
        notify,
        otherProjects,
      }}
    >
      {children}
    </ComposerSourcesProvider>
  )
}

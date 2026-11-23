import type { TitanState } from '#app/model.ts'
import { hydraConfig } from '#titan/config.ts'
import { TITAN_CARD } from '#titan/identity.ts'
import type { Catalog } from '#titan/transcripts-catalog.ts'
import type { TitanProject } from '#projects/model.ts'
import { projectGroups, type ProjectGroup } from '#projects/groups.ts'
import type { Card,SavedLabelColor } from '#tasks/model.ts'
import type { Command } from '#web-app/connection.ts'
import type { TaskReferenceData } from '#web-tasks/task-reference.tsx'
import { createContext,useCallback,useContext,useMemo,useRef,useState,type ReactNode } from 'react'
import { useSkillsCatalog } from './skills-catalog.ts'

// What every composer field offers to mention, open and invoke; the app provides it once.
export interface ComposerSources {
  cards: Card[]
  projects: TitanProject[]
  columns: ProjectGroup[]
  taskReferences: Record<string, TaskReferenceData>
  openTask({ id }: { id: string }): void
  catalog: Catalog | null
  // A field asks for the skills catalog while its / menu is open.
  catalogOpen({ open }: { open: boolean }): void
  labelColors?: SavedLabelColor[]
  // Projects of the owner's other Titans, offered under Folders in the @ picker.
  otherProjects: {
    name: string
    path: string
    hydra: string
  }[]
  notify({ text }: { text: string }): void
}

const Sources = createContext<ComposerSources | null>(null)

function ComposerSourcesProvider({
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

// Every composer field in a Titan mentions its tasks, projects and columns and offers Titan's skills.
export function TitanComposerSources({
  state,
  command,
  connected,
  references,
  openTask,
  notify,
  otherProjects,
  children,
}: {
  state: TitanState
  command: Command
  connected: boolean
  references: Record<string, TaskReferenceData>
  openTask({ id }: { id: string }): void
  notify({ text }: { text: string }): void
  otherProjects: ComposerSources['otherProjects']
  children: ReactNode
}) {
  const config = hydraConfig({ state }), card = state.cards[TITAN_CARD]
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
  const catalog = useSkillsCatalog({
    identity: JSON.stringify([
      TITAN_CARD,
      card?.agent?.provider,
      card?.agent?.cwd,
      card?.agent?.sessionId,
      config.hydra.agent?.harness,
    ]),
    card: TITAN_CARD,
    provider: config.hydra.agent?.harness ?? card?.agent?.provider,
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
        columns: projectGroups({ state }),
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

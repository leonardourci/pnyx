import type { TitanState } from '#app/model.ts'
import { hydraConfig } from '#titan/config.ts'
import { TITAN_CARD } from '#titan/identity.ts'
import type { Catalog } from '#titan/transcripts-catalog.ts'
import type { TitanProject } from '#projects/model.ts'
import { projectGroups } from '#projects/groups.ts'
import type { SavedLabelColor } from '#tasks/model.ts'
import type { PreparedRow } from '#titan/suggestion-matches.ts'
import type { Command } from '#web-app/connection.ts'
import type { TaskReferenceData } from '#web-tasks/task-reference.tsx'
import { createContext,useCallback,useContext,useMemo,useRef,useState,type ReactNode } from 'react'
import { useKept,useStableActions } from '#web-shared/stable.ts'
import { useSkillsCatalog } from './skills-catalog.ts'
import { columnRows,projectRows,taskRowsOf,titanRows } from './mention-candidates.ts'
import type { MentionItem } from './mention-picker.tsx'
import { slashRows,type SlashItem } from './slash-menu.tsx'

// What every composer field offers to mention, open and invoke; the app provides it once.
export interface ComposerSources {
  projects: TitanProject[]
  // The @ and / lists, built once per source version; each field only filters them.
  mentionRows: PreparedRow<MentionItem>[]
  slashRows: PreparedRow<SlashItem>[]
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

export interface OtherTitan {
  id: string
  name: string
  icon: string
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
  otherTitans,
  children,
}: {
  state: TitanState
  command: Command
  connected: boolean
  references: Record<string, TaskReferenceData>
  openTask({ id }: { id: string }): void
  notify({ text }: { text: string }): void
  otherProjects: ComposerSources['otherProjects']
  otherTitans: OtherTitan[]
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
      config.hydra.agent?.harness,
    ]),
    card: TITAN_CARD,
    provider: config.hydra.agent?.harness ?? card?.agent?.provider,
    command,
    connected,
    open,
  })
  const projects = state.projects
  // The workspace derives these on every render; the lists rebuild only when their content changes.
  const titans = useKept({ value: otherTitans })
  const folders = useKept({ value: otherProjects })
  const actions = useStableActions({
    actions: {
      openTask,
      notify,
    },
  })
  const labelColors = state.labelColors
  const columns = useMemo(
    () => projectGroups({ state: { projects } }),
    [projects],
  )
  const projectList = useMemo(
    () => [
      ...projectRows({ projects: projects ?? [] }),
      ...titanRows({ titans }),
      ...columnRows({ columns }),
    ],
    [
      projects,
      titans,
      columns,
    ],
  )
  const mentionRows = useMemo(
    () => [
      ...projectList,
      ...taskRowsOf({
        cards: Object.values(state.cards),
        references,
      }),
    ],
    [
      projectList,
      state.cards,
      references,
    ],
  )
  const commands = useMemo(
    () => slashRows({
      catalog,
      labelColors,
    }),
    [
      catalog,
      labelColors,
    ],
  )
  const sources = useMemo(
    () => ({
      projects: projects ?? [],
      mentionRows,
      slashRows: commands,
      taskReferences: references,
      openTask: actions.openTask,
      catalog,
      catalogOpen,
      labelColors,
      notify: actions.notify,
      otherProjects: folders,
    }),
    [
      projects,
      mentionRows,
      commands,
      references,
      actions,
      catalog,
      catalogOpen,
      labelColors,
      folders,
    ],
  )

  return <ComposerSourcesProvider sources={sources}>{children}</ComposerSourcesProvider>
}

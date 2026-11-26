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
import { columnRows,fileRows,projectRows,taskRows,titanRows } from './mention-candidates.ts'
import type { ProjectFiles } from '#projects/file-index.ts'
import { useCachedList } from '#web-shared/cached-list.ts'
import type { MentionItem } from './mention-picker.tsx'
import { slashRows,type SlashItem } from './slash-menu.tsx'

// What every composer field offers to mention, open and invoke; the app provides it once.
export interface ComposerSources {
  projects: TitanProject[]
  mentionRows: PreparedRow<MentionItem>[]
  fileRows: PreparedRow<MentionItem>[]
  slashRows: PreparedRow<SlashItem>[]
  taskReferences: Record<string, TaskReferenceData>
  openTask({ id }: { id: string }): void
  catalog: Catalog | null
  catalogOpen({ open }: { open: boolean }): void
  mentionOpen({ open }: { open: boolean }): void
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

function useOpenInAnyField() {
  const [
    open,
    setOpen,
  ] = useState(false)
  const fieldsOpen = useRef(0)
  const opened = useCallback(
    ({ open }: { open: boolean }) => {
      fieldsOpen.current += open ? 1 : -1
      setOpen(fieldsOpen.current > 0)
    },
    [],
  )

  return {
    open,
    opened,
  }
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
  const {
    open: slashMenuOpen,
    opened: catalogOpen,
  } = useOpenInAnyField()
  const {
    open: mentionMenuOpen,
    opened: mentionOpen,
  } = useOpenInAnyField()
  const attached = (state.projects ?? []).filter(project => !project.detached)
  const projectPaths = attached.map(project => project.path)
  const files = useCachedList<ProjectFiles[]>({
    key: `files:${JSON.stringify(projectPaths)}`,
    connected,
    open: mentionMenuOpen,
    fetch: async () => (await command({
      name: 'files',
      args: [],
    })).projects as ProjectFiles[],
  })
  const projectFileRows = useMemo(
    () => fileRows({ projects: files.value ?? [] }),
    [files.value],
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
    open: slashMenuOpen,
  })
  const projects = state.projects
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
  const projectsTitansAndColumns = useMemo(
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
      ...projectsTitansAndColumns,
      ...taskRows({
        cards: Object.values(state.cards),
        references,
      }),
    ],
    [
      projectsTitansAndColumns,
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
      fileRows: projectFileRows,
      slashRows: commands,
      taskReferences: references,
      openTask: actions.openTask,
      catalog,
      catalogOpen,
      mentionOpen,
      labelColors,
      notify: actions.notify,
      otherProjects: folders,
    }),
    [
      projects,
      mentionRows,
      projectFileRows,
      commands,
      references,
      actions,
      catalog,
      catalogOpen,
      mentionOpen,
      labelColors,
      folders,
    ],
  )

  return <ComposerSourcesProvider sources={sources}>{children}</ComposerSourcesProvider>
}

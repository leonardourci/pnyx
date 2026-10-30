import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import type { HydraState } from '#app/model.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { hydraConfig } from '#hydra/config.ts'
import type { Command } from '#web-app/connection.ts'
import type { TaskReferenceData } from '#web-tasks/task-reference.tsx'
import { ComposerSourcesProvider, type ComposerSources } from '#web-shared/ui/composer-field.tsx'
import { useSkillsCatalog } from './skills-catalog.ts'

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
      receiving === 'claude-code' ? 'claude' : receiving,
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

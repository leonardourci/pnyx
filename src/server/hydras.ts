import { commands } from '../cli/commands.ts'
import { hydraConfig } from '../core/hydra.ts'
import { hydraIds, loadHydra } from '../store/hydra-store.ts'
import { projectsFor } from '../projects/read.ts'
import { liveTask } from '../core/tasks.ts'

export interface HydraProjectSummary {
  name: string
  path: string
  references: string[]
  live: number
  asks: number
}
export interface HydraSummary {
  id: string
  name: string
  hydra: string
  projects: HydraProjectSummary[]
}

// Unreadable Hydras remain reachable so opening one reports the error.
export function listHydras(): HydraSummary[] {
  return hydraIds().map(id => {
    try {
      const state = loadHydra({ hydraId: id }).state
      const config = hydraConfig({ state, id })
      const cards = Object.values(state.cards).filter(c => liveTask({ card: c }))
      const projects = projectsFor({ state, aliases: true }).filter(p => !p.detached)
        .map(p => {
          const references = [p.path, ...(config.hydra.kind === 'firstmate' ? [p.name, ...p.aliases ?? []] : [])]
          const tasks = cards.filter(c => c.project && references.includes(c.project))

          const live = tasks.filter(c => c.agent && (c.sessionActivity ?? c.activity) === 'working')
          const asks = tasks.flatMap(c => c.attention).filter(a => !a.answered)

          return { name: p.name, path: p.path, references, live: live.length, asks: asks.length }
        })

      return { id, name: config.name, hydra: config.hydra.kind === 'firstmate' ? `Firstmate ${config.hydra.home}` : config.hydra.name, projects }
    } catch {
      return { id, name: id, hydra: 'could not be loaded', projects: [] }
    }
  })
}

export function createHydra({ name }: { name: string }): string {
  const taken = new Set(hydraIds())
  let n = taken.size + 1

  while (taken.has(`hydra-${n}`)) {
    n++
  }

  const id = `hydra-${n}`
  commands.hydra(['create', id, '--name', name, '--actor', 'web'])

  return id
}

export function renameHydra({ id, name }: { id: string; name: string }): void {
  commands.hydra(['set', '--hydra', id, '--name', name, '--actor', 'web'])
}

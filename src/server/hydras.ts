import { commands } from '../cli/commands.ts'
import { hydraConfig } from '../core/hydra.ts'
import { hydraIds, loadHydra } from '../store/hydra-store.ts'

export interface HydraTab { id: string; name: string; hydra: string }

// A Hydra that cannot be read still gets a tab, so opening it reports why.
export function listHydras(): HydraTab[] {
  return hydraIds().map(id => {
    try {
      const config = hydraConfig({ state: loadHydra({ hydraId: id }).state, id })

      return { id, name: config.name, hydra: config.hydra.kind === 'firstmate' ? `Firstmate ${config.hydra.home}` : config.hydra.name }
    } catch {
      return { id, name: id, hydra: 'could not be loaded' }
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

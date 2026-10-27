import { learningConditions } from './learnings.ts'
import type { HydraState } from '../app/model.ts'
import { loadHydra } from '../app/store.ts'
import { hydraIds } from '../app/home-migration.ts'

export function memoryConditions() {
  const states: Record<string, HydraState> = {}

  for (const hydraId of hydraIds()) {
    try {
      states[hydraId] = loadHydra({ hydraId }).state
    } catch (error) {
      console.error(`pnyx-axi: memory conditions unavailable for Hydra ${hydraId}: ${(error as Error).message}`)
    }
  }

  return learningConditions({ states })
}

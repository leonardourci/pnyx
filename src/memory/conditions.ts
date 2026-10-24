import { learningConditions } from './learnings.ts'
import type { HydraState } from '../core/model.ts'
import { hydraIds, loadHydra } from '../store/hydra-store.ts'

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

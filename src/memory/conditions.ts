import { log } from '#app/diagnostics.ts'
import { learningConditions } from './learnings.ts'
import type { HydraState } from '#app/model.ts'
import { hydraIds } from '#app/home-migration.ts'
import { loadHydra } from '#app/store.ts'

export function memoryConditions() {
  const states: Record<string, HydraState> = {}

  for (const hydraId of hydraIds()) {
    try {
      states[hydraId] = loadHydra({ hydraId }).state
    } catch (error) {
      log({
        level: 'warn',
        operation: 'memory.conditions',
        hydraId,
        error,
      })
    }
  }

  return learningConditions({ states })
}

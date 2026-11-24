import { log } from '#app/diagnostics.ts'
import { learningConditions } from './learnings.ts'
import type { TitanState } from '#app/model.ts'
import { hydraIds } from '#app/home-migration.ts'
import { loadTitan } from '#app/store.ts'

export function memoryConditions() {
  const states: Record<string, TitanState> = {}

  for (const hydraId of hydraIds()) {
    try {
      states[hydraId] = loadTitan({ hydraId }).state
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

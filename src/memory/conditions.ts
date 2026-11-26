import { log } from '#app/diagnostics.ts'
import { learningConditions } from './learnings.ts'
import type { TitanState } from '#app/model.ts'
import { hydraIds } from '#app/home-migration.ts'
import { loadTitan } from '#app/store.ts'

export function memoryConditions() {
  const states: Record<string, TitanState> = {}

  for (const titanId of hydraIds()) {
    try {
      states[titanId] = loadTitan({ titanId }).state
    } catch (error) {
      log({
        level: 'warn',
        operation: 'memory.conditions',
        titanId,
        error,
      })
    }
  }

  return learningConditions({ states })
}

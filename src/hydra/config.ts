import type { HydraState } from '#app/model.ts'
import type { HydraConfig } from './model.ts'

export function hydraConfig({
  state,
  id = 'default',
}: {
  state: HydraState
  id?: string
}): HydraConfig {
  return state.config ?? {
    id,
    name: id,
    hydra: {
      id: 'hydra',
      name: 'Hydra',
    },
  }
}

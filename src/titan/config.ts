import type { TitanState } from '#app/model.ts'
import type { TitanConfig } from './model.ts'

export function hydraConfig({
  state,
  id = 'default',
}: {
  state: TitanState
  id?: string
}): TitanConfig {
  return state.config ?? {
    id,
    name: id,
    hydra: {
      id: 'hydra',
      name: 'Titan',
    },
  }
}

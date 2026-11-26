import type { TitanState } from '#app/model.ts'
import type { TitanConfig } from './model.ts'

export function titanConfig({
  state,
  id = 'default',
}: {
  state: TitanState
  id?: string
}): TitanConfig {
  return state.config ?? {
    id,
    name: id,
    titan: {
      id: 'titan',
      name: 'Titan',
    },
  }
}

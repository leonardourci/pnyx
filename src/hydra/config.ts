import type { HydraState } from '#app/model.ts'
import type { HydraConfig } from './model.ts'
import { DEFAULT_COLUMNS } from '#tasks/column-defaults.ts'

// ponytail: a never-configured Hydra replays onto the defaults directly, so only its cards moved into Workers on it get placed by status; record a layout version if such logs ever matter.
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
      kind: 'agent',
      name: 'Hydra',
    },
    columns: [
      ...structuredClone(DEFAULT_COLUMNS),
      ...(state.view?.customColumns ?? []),
    ],
  }
}

// Pnyx runs this Hydra's agent itself, so it knows when a turn starts and ends.
export const hostedHydra = ({ state }: { state: HydraState }) => hydraConfig({ state }).hydra.kind !== 'firstmate'

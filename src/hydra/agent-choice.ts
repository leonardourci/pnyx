import type { HydraState } from '#app/model.ts'
import type { HeadsDispatch, Candidate } from '#workers/dispatch-config.ts'

export function hydraCandidate({
  state,
  dispatch,
}: {
  state: Pick<HydraState, 'config'>
  dispatch: HeadsDispatch
}): Candidate {
  return state.config?.hydra.agent ?? dispatch.rules.hydra?.candidates[0]
    ?? dispatch.default[0] ?? { harness: 'claude' }
}

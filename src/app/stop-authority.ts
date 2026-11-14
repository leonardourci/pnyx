import { HydraError } from '#store/errors.ts'
import type { Meta } from './command-meta.ts'
import { workerIdentity } from '#workers/worker-identity.ts'

// Stop and Send now act on another agent's turn, so only the owner and Hydra may ask for them.
export function requireStopAuthority({ meta }: { meta: Meta }): void {
  if (workerIdentity({ actor: meta.actor })) {
    throw new HydraError({
      message: 'Only the owner or Hydra stops an agent or sends a message now',
      code: 'OWNER_ONLY',
      help: ['Ask Hydra with `pnyx-axi task ask <task> --question "<why the agent should stop>"`'],
    })
  }
}

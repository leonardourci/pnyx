import { HydraError } from '#store/errors.ts'
import type { Meta } from './command-meta.ts'
import { requestEnv } from './request-context.ts'

// Stop and Send now act on another agent's turn, so only the owner and Hydra may ask for them.
export function requireStopAuthority({ meta }: { meta: Meta }): void {
  const identity = requestEnv()
  const worker = Boolean(identity.PNYX_TASK || identity.PNYX_STEERING_WORKER)
    || Boolean(identity.PNYX_ACTOR?.startsWith('worker:')) || meta.actor.startsWith('worker:')

  if (worker) {
    throw new HydraError({
      message: 'Only the owner or Hydra stops an agent or sends a message now',
      code: 'OWNER_ONLY',
      help: ['Ask Hydra with `pnyx-axi task ask <task> --question "<why the agent should stop>"`'],
    })
  }
}

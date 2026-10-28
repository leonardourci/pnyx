import type { Host } from './host-types.ts'
import { isHelper, taskLease } from '../helper/leases.ts'
import { HydraError } from '../store/errors.ts'
import { loadHydra } from './store.ts'
import { findCard } from '../core/decide.ts'
import { helperGrant } from '../helper/route.ts'
import { hostRequestUnlocked } from './host.ts'

export async function hostRequest({
  host,
  body,
}: {
  host: Host
  body: unknown
}): Promise<Record<string, unknown>> {
  const request = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
  const actor = typeof request.actor === 'string' ? request.actor : 'cli'
  const helper = isHelper({ actor })
  const action = request.action

  if (helper && action !== 'send' && action !== 'continue') {
    throw new HydraError({
      message: 'This action belongs to the main Hydra',
      code: 'MAIN_ONLY',
    })
  }

  const ref = request.task ?? request.card
  let release = () => {}

  if (typeof ref === 'string' && [
    'start',
    'continue',
    'send',
    'set',
    'permission',
  ].includes(String(action))) {
    const state = loadHydra({ hydraId: host.hydraId }).state
    const card = findCard({
      state,
      ref,
    })

    if (helper && !helperGrant({
      state,
      task: card.id,
      actor,
    })) {
      throw new HydraError({
        message: 'This task now belongs to the main Hydra',
        code: 'MAIN_ONLY',
      })
    }

    release = taskLease({
      hydraId: host.hydraId,
      task: card.id,
      actor: helper ? actor : 'main',
    })
  }

  try {
    return await hostRequestUnlocked({
      host,
      body,
    })
  } finally {
    release()
  }
}

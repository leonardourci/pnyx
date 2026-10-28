import { isDeepStrictEqual } from 'node:util'
import type { HydraState, Decision } from '#app/model.ts'
import { base, type Meta } from '#app/command-meta.ts'
import { HydraError } from '#store/errors.ts'
import { viewFor, patchView } from './view.ts'
import { removedColumnPlacements } from '#tasks/columns-decisions.ts'

export function decideView({
  state,
  patch,
  meta,
}: {
  state: HydraState
  patch: unknown
  meta: Meta
}): Decision {
  if (meta.id && meta.id in state.eventIds) {
    return { skipped: 'duplicate' }
  }

  if (meta.ifRevision !== undefined && meta.ifRevision !== (state.viewRevision ?? 0)) {
    throw new HydraError({
      message: 'view preferences changed; reload and retry',
      code: 'REVISION_CONFLICT',
    })
  }

  const before = viewFor({ state }), after = patchView({
    state,
    input: patch,
  })

  if (isDeepStrictEqual(
    before,
    after,
  )) {
    return { skipped: 'unchanged' }
  }

  const placements = removedColumnPlacements({
    state,
    after,
  })

  return {
    event: {
      ...base({
        state,
        meta,
        cardId: '$board',
      }),
      type: 'board.view',
      data: {
        before,
        after,
        ...(placements.length ? { placements } : {}),
      },
    },
  }
}

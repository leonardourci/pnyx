import { isDeepStrictEqual } from 'node:util'
import type { TitanState, Decision } from '#app/model.ts'
import { base, type Meta } from '#app/command-meta.ts'
import { TitanError } from '#store/errors.ts'
import { viewFor, patchView } from './view.ts'

export function decideView({
  state,
  patch,
  meta,
}: {
  state: TitanState
  patch: unknown
  meta: Meta
}): Decision {
  if (meta.id && Object.hasOwn(
    state.eventIds,
    meta.id,
  )) {
    return { skipped: 'duplicate' }
  }

  if (meta.ifRevision !== undefined && meta.ifRevision !== (state.viewRevision ?? 0)) {
    throw new TitanError({
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

  return {
    event: {
      ...base({
        state,
        meta,
        cardId: '$all',
      }),
      type: 'titan.view',
      data: {
        before,
        after,
      },
    },
  }
}

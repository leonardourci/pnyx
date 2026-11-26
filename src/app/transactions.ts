import { type EventBase } from '#store/events.ts'
import type { Output } from './cli-support.ts'
import { TitanError } from '#store/errors.ts'
import { nativeHome } from './native-home.ts'

export type ApplyRecordedEvent = EventBase & {
  type: 'apply.recorded'
  data: { digest: string }
}

export function transactionReceipt({
  titanId,
  id,
  digest,
  eventIds,
}: {
  titanId: string
  id: string
  digest: string
  eventIds?: Record<string, unknown>
}): Output | undefined {
  const home = nativeHome()
  const current = home.read({ titan: titanId })
  const knownIds = eventIds ?? current.state.eventIds
  const recorded = home.receipts.get(titanId)?.get(id)

  if (!recorded) {
    if (Object.hasOwn(
      knownIds,
      id,
    )) {
      throw new TitanError({
        code: 'IDEMPOTENCY_CONFLICT',
        message: `event id ${id} already belongs to an individual event`,
      })
    }

    return undefined
  }

  if (recorded.digest !== digest) {
    throw new TitanError({
      code: 'IDEMPOTENCY_CONFLICT',
      message: `apply event id ${id} was already used with different contents or actor`,
    })
  }

  return {
    ...structuredClone(recorded.value),
    duplicate: true,
  }
}

import type { PendingIntent } from '../../hydra/pending-intents.ts'

export function PendingStatus({ intents }: { intents: PendingIntent<unknown>[] }) {
  const unknown = intents.some(intent => intent.stage === 'unknown')
  const pending = intents.some(intent => [
    'pending',
    'sending',
    'accepted',
  ].includes(intent.stage))

  if (!pending && !unknown) {
    return null
  }

  return (
    <p className="pending-status" role="status" data-pending={unknown ? 'unknown' : 'saving'}>
      {unknown ? 'Checking whether your changes were saved…' : 'Saving changes…'}
    </p>
  )
}

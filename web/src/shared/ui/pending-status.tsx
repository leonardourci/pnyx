import { StatusMessage } from './status-message.tsx'
import type { PendingIntent } from '#web-shared/pending-intents.ts'

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
    <StatusMessage pending role="status" data-pending={unknown ? 'unknown' : 'saving'}>
      {unknown ? 'Checking whether your changes were saved…' : 'Saving changes…'}
    </StatusMessage>
  )
}

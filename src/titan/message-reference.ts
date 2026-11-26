import { TITAN_CARD } from './identity.ts'

const COMMENT_CONTEXT_MESSAGES = 3

export function messageReference({
  session,
  id,
  messageId,
}: {
  session: string
  id: string
  messageId?: string
}): string {
  const native = messageId ?? id

  return native.startsWith(`${session}:`) ? native : `${session}:${native}`
}

const shellArgument = ({ value }: { value: string }) => `'${value.replaceAll(
  "'",
  "'\\''",
)}'`

export function messageLookupCommand({
  reference,
  at,
  titanId,
  card = TITAN_CARD,
}: {
  reference?: string
  at?: string
  titanId?: string
  card?: string
}): string | undefined {
  if (!reference && !at?.match(/^\d{4}-\d{2}-\d{2}T/)) {
    return
  }

  const command = card === TITAN_CARD ? 'hydra message' : `task messages ${shellArgument({ value: card })}`
  const selector = reference ? `--id ${shellArgument({ value: reference })}` : `--at ${shellArgument({ value: at! })}`
  const hydra = titanId ? ` --titan ${shellArgument({ value: titanId })}` : ''

  return `othrys ${command} ${selector} --before ${COMMENT_CONTEXT_MESSAGES} --after ${COMMENT_CONTEXT_MESSAGES}${hydra}`
}

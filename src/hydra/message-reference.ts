import { HYDRA_CARD } from './identity.ts'

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
  return `${session}:${messageId ?? id}`
}

const shellArgument = ({ value }: { value: string }) => `'${value.replaceAll(
  "'",
  "'\\''",
)}'`

export function messageLookupCommand({
  reference,
  at,
  hydraId,
  card = HYDRA_CARD,
}: {
  reference?: string
  at?: string
  hydraId?: string
  card?: string
}): string | undefined {
  if (!reference && !at?.match(/^\d{4}-\d{2}-\d{2}T/)) {
    return
  }

  const command = card === HYDRA_CARD ? 'hydra message' : `task messages ${shellArgument({ value: card })}`
  const selector = reference ? `--id ${shellArgument({ value: reference })}` : `--at ${shellArgument({ value: at! })}`
  const hydra = hydraId ? ` --hydra ${shellArgument({ value: hydraId })}` : ''

  return `pnyx-axi ${command} ${selector} --before ${COMMENT_CONTEXT_MESSAGES} --after ${COMMENT_CONTEXT_MESSAGES}${hydra}`
}

import { STEERING_NOTICE } from './steering-text.ts'
import { HydraError } from '#store/errors.ts'
import { nativeHome } from '#app/native-home.ts'
import type { SteeringClaim } from './model.ts'
import { recordContext } from '#hydra/file-context.ts'
import type { ReplyState } from './model.ts'

export interface NotificationResult {
  result: 'delivered' | 'unknown' | 'failed' | 'deferred' | 'gone'
  busy?: true
  detail?: string
}

export function notificationState({ state }: { state: ReplyState }): NotificationResult['result'] {
  switch (state) {
    case 'delivered': return 'delivered'
    case 'failed': return 'failed'
    default: return 'unknown'
  }
}

export function notificationReceipt({ result }: NotificationResult): ReplyState {
  switch (result) {
    case 'delivered': return 'delivered'
    case 'failed':
    case 'gone': return 'failed'
    default: return 'delivery_unknown'
  }
}

// The owner's instructions themselves, first time they reach the worker; the inbox keeps them as the record.
export function steeringMessages({
  task,
  hydraId,
  messages,
}: {
  task: string
  hydraId: string
  messages: {
    id: string
    text: string
  }[]
}): string {
  return [
    `New instructions for task ${task}, in order (Pnyx inbox IDs ${JSON.stringify(messages.map(message => message.id))}):`,
    messages.map(message => message.text).join('\n\n---\n\n'),
    `Pnyx marks them read once you receive this. ${recordContext({
      hydraId,
      task,
    })} Apply them in order and report progress and blockers separately. A repeated notice is not a new instruction.`,
  ].join('\n\n')
}

export function steeringNotice({
  task,
  hydraId,
  ids,
  claim,
}: {
  task: string
  hydraId: string
  ids: string[]
  claim: SteeringClaim
}): string {
  const assignment = [...nativeHome().references({ hydra: hydraId })].findLast(([
    , position,
  ]) => position === claim.generation)?.[0]

  if (assignment === undefined) {
    throw new HydraError({
      code: 'STALE_CLAIM',
      message: 'The inbox assignment has no durable record reference',
    })
  }

  const quote = ({ value }: { value: string }) => `'${value.replace(
    /'/g,
    "'\\''",
  )}'`
  const acknowledgement = ids.map(id => [
    'pnyx task ack',
    quote({ value: task }),
    quote({ value: id }),
    '--session',
    quote({ value: claim.session }),
    '--generation',
    quote({ value: JSON.stringify({ native: assignment }) }),
    '--hydra',
    quote({ value: hydraId }),
  ].join(' ')).join('\n')

  return `${STEERING_NOTICE}${JSON.stringify(ids)}. ${recordContext({
    hydraId,
    task,
  })} Read the full instructions before acknowledging these exact IDs with the supplied assignment reference:\n${acknowledgement}\nAn acknowledgement means read, never completed work. Apply the pending messages in order; report progress and blockers separately. A repeated notice is not a new instruction. Do not repeat an effect already checkpointed.`
}

export function readSteeringMessages({
  text,
  task,
}: {
  text: string
  task: string
}): string[] {
  const prefix = `New instructions for task ${task}, in order (Pnyx inbox IDs `
  const end = text.indexOf('):\n')

  if (!text.startsWith(prefix) || end < prefix.length) {
    return []
  }

  try {
    const ids: unknown = JSON.parse(text.slice(
      prefix.length,
      end,
    ))

    return Array.isArray(ids) && ids.every(id => typeof id === 'string') ? ids : []
  } catch {
    return []
  }
}

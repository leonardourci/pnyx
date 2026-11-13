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

const NOTICE = 'Pnyx steering inbox has pending instruction IDs '
const MESSAGES = /^New instructions for task \S+, in order \(Pnyx inbox IDs /

// Text Pnyx itself sent a worker to steer it, not words from the owner.
export const steeringText = ({ text }: { text: string }) =>
  text.startsWith(NOTICE) || MESSAGES.test(text)

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
    `Pnyx marks them read once you receive this; \`pnyx-axi task inbox read ${task} --hydra ${hydraId}\` shows anything still pending. Apply them in order and report progress and blockers separately. A repeated notice is not a new instruction.`,
  ].join('\n\n')
}

export function steeringNotice({
  task,
  hydraId,
  ids,
}: {
  task: string
  hydraId: string
  ids: string[]
}): string {
  return `${NOTICE}${JSON.stringify(ids)}. Run \`pnyx-axi task inbox read ${task} --hydra ${hydraId}\`, which records read acknowledgements and stops reminders. Apply the returned messages in order; report progress and blockers separately. An acknowledgement means read, never completed work. A repeated notice is not a new instruction. Do not repeat an effect already checkpointed.`
}

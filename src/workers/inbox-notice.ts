import type { ReplyState } from './model.ts'

export interface NotificationResult {
  result: 'delivered' | 'unknown' | 'failed' | 'deferred' | 'gone'
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

export function steeringNotice({
  task,
  hydraId,
  ids,
}: {
  task: string
  hydraId: string
  ids: string[]
}): string {
  return `Pnyx steering inbox has pending instruction IDs ${JSON.stringify(ids)}. Run \`pnyx-axi task inbox read ${task} --hydra ${hydraId}\`, which records read acknowledgements and stops reminders. Apply the returned messages in order; report progress and blockers separately. An acknowledgement means read, never completed work. A repeated notice is not a new instruction. Do not repeat an effect already checkpointed.`
}

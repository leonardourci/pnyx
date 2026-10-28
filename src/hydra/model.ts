import type { AgentConfig } from '../workers/model.ts'
import type { HydraColumn } from '../tasks/columns-model.ts'
import type { AnswerMessage } from '../tasks/model.ts'
import type { EventBase } from '../store/events.ts'

export interface HydraIdentity {
  agent?: AgentConfig
  id: string
  kind: 'agent' | 'firstmate'
  name: string
  session?: string
  home?: string
}

export interface HydraConfig {
  helper?: AgentConfig | false
  id: string
  name: string
  hydra: HydraIdentity
  columns: HydraColumn[]
  // Retained so pre-dispatch event logs still replay.
  agents?: Record<string, AgentConfig>
  command?: string
  // The command makes its own folder, so starts through it skip the task copy.
  commandOwnsFolder?: boolean
  doneAfterHours?: number
  reviewMinutes?: number
}

export interface HydraMessage {
  id: string
  task?: string
  action: 'send' | 'worker'
  // A worker's progress report: it stays on the card and reaches Hydra with its next wake, never waking it alone.
  kind?: 'progress'
  text: string
  enteredText?: string
  details?: string
  context?: string
  // ask: the worker question this message delivers; answers: Hydra's question this owner message answers.
  ask?: string
  answers?: string
  fromMessage?: AnswerMessage
  choice?: string
  at: string
  actor: string
  hydra: string
}

// Whether Pnyx can start the Hydra it runs: down from a failed start until a start works again.
export interface HydraStatus {
  state: 'down' | 'up'
  since: string
  detail?: string
  // Down only: the last change before the message or wake that met the failure; the recap lists what came after it.
  after?: number
}

export type ChatEvent = EventBase & {
  type: 'chat.message'
  data: {
    session: string
    nativeId: string
    role: string
    text: string
  }
}

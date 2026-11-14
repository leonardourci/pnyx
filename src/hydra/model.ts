import type { AgentConfig } from '#workers/model.ts'
import type { HydraColumn } from '#tasks/columns-model.ts'
import type { AnswerMessage } from '#tasks/model.ts'
import type { EventBase } from '#store/events.ts'

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
  // An identity icon id from hydra-names.ts; without one the Hydra shows the Hydra mark.
  icon?: string
  // Sort key in the Hydra list, in the same scale as creation time in ms; unset sorts by creation time.
  position?: number
  hydra: HydraIdentity
  columns: HydraColumn[]
  // Retained so pre-dispatch event logs still replay.
  agents?: Record<string, AgentConfig>
  command?: string
  // The command makes its own folder, so starts through it skip the task copy.
  commandOwnsFolder?: boolean
  // Retained so older logs replay; the settings every Hydra shares now hold these and the helper.
  doneAfterHours?: number
  reviewMinutes?: number
}

export interface HydraMessage {
  id: string
  task?: string
  action: 'send' | 'worker'
  // A worker's progress report: it stays on the card and reaches Hydra with its next wake, never waking it alone.
  // divider: Pnyx's milestone line in the conversation.
  kind?: 'progress' | 'divider' | 'routine'
  text: string
  reminderQuestions?: string[]
  enteredText?: string
  details?: string
  context?: string
  // ask: the worker question this message delivers; answers: Hydra's question this owner message answers.
  ask?: string
  answers?: string
  discusses?: string
  fromMessage?: AnswerMessage
  choice?: string
  liftsHold?: string
  at: string
  actor: string
  hydra: string
  // When Hydra's harness confirmed it took the message.
  received?: string
  stopped?: boolean
}

export const isRoutineMessage = ({ message }: { message: HydraMessage }) => message.kind === 'routine'

// Whether Pnyx can start the Hydra it runs: down from a failed start until a start works again.
export interface HydraStatus {
  state: 'down' | 'up'
  since: string
  detail?: string
  // Down only: the last change before the message or wake that met the failure; the recap lists what came after it.
  after?: number
}

// Something that stops or blocks Hydra for a while: a restart, an upgrade's restart or a compaction.
export interface HydraOperation {
  id: string
  kind: 'restart' | 'upgrade' | 'compaction' | 'inscribe'
  state: 'started' | 'finished' | 'failed'
  error?: string
  // On start: the last event before the oldest message already waiting for Hydra, so the recap covers it too.
  after?: number
  // The last log position covered, fixed before the operation starts reading.
  through?: number
  historySince?: string
  // An inscribe pass within a switch shares its compaction's chat divider.
  parent?: string
  // Overlapping operations can record a milestone without taking over the existing stop.
  blocking?: false
}

export type ChatEvent = EventBase & {
  type: 'chat.message'
  data: {
    session: string
    nativeId: string
    replaces?: string
    block?: number
    final?: boolean
    messageId?: string
    part?: number
    kind?: 'message' | 'tool' | 'thinking'
    hidden?: boolean
    call?: string
    role: string
    text: string
  }
}

export interface HydraAgentChange {
  id: string
  previous: AgentConfig
  next: AgentConfig
  kind: 'agent' | 'effort'
  // Cancelled: withdrawn without running, by a new agent choice, Stop, or removing what it held; never stored.
  state: 'requested' | 'running' | 'finished' | 'failed' | 'cancelled'
  choice?: 'inscribe' | 'compact' | 'neither'
  operation?: string
  summary?: string
  previousSession?: string
  error?: string
}

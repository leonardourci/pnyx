import type { AgentConfig } from '#workers/model.ts'
import type { AnswerMessage } from '#tasks/model.ts'
import type { EventBase } from '#store/events.ts'

export interface TitanIdentity {
  agent?: AgentConfig
  id: string
  name: string
  session?: string
}

export interface TitanConfig {
  removed?: boolean
  removing?: boolean
  removalWork?: Record<string, string>
  polis?: string
  helper?: AgentConfig | false
  id: string
  name: string
  // An identity icon id from titan-names.ts; without one the Titan shows the Titan mark.
  icon?: string
  // Sort key in the Titan list, in the same scale as creation time in ms; unset sorts by creation time.
  position?: number
  hydra: TitanIdentity
  // Retained so pre-dispatch event logs still replay.
  agents?: Record<string, AgentConfig>
  command?: string
  // The command makes its own folder, so starts through it skip the task copy.
  commandOwnsFolder?: boolean
  // Retained so older logs replay; the settings every Titan shares now hold these and the helper.
  doneAfterHours?: number
  reviewMinutes?: number
}

export interface TitanMessage {
  id: string
  task?: string
  action: 'send' | 'worker'
  // divider: Othrys's milestone line in the conversation.
  kind?: 'divider' | 'routine'
  text: string
  reminderQuestions?: string[]
  enteredText?: string
  details?: string
  context?: string
  // ask: the worker question this message delivers; answers: Titan's question this owner message answers.
  ask?: string
  answers?: string
  discusses?: string
  fromMessage?: AnswerMessage
  choice?: string
  liftsHold?: string
  at: string
  actor: string
  hydra: string
  // When Titan's harness confirmed it took the message.
  received?: string
  stopped?: boolean
  failure?: string
  attempt?: number
}

export const isRoutineMessage = ({ message }: { message: TitanMessage }) => message.kind === 'routine'

// Whether Othrys can start the Titan it runs: down from a failed start until a start works again.
export interface TitanStatus {
  state: 'down' | 'up'
  since: string
  detail?: string
  // Down only: the last change before the message or wake that met the failure; the recap lists what came after it.
  after?: number
}

// Something that stops or blocks Titan for a while: a restart, an upgrade's restart or a compaction.
export interface TitanOperation {
  id: string
  kind: 'restart' | 'upgrade' | 'compaction' | 'inscribe'
  state: 'started' | 'finished' | 'failed'
  error?: string
  // On start: the last event before the oldest message already waiting for Titan, so the recap covers it too.
  after?: number
  // The last log position covered, fixed before the operation starts reading.
  through?: number
  historySince?: string
  parent?: string
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

export interface TitanAgentChange {
  id: string
  previous: AgentConfig
  next: AgentConfig
  kind: 'agent' | 'effort'
  state: 'requested' | 'running' | 'finished' | 'failed' | 'cancelled'
  choice?: 'inscribe' | 'compact' | 'neither'
  operation?: string
  summary?: string
  previousSession?: string
  error?: string
}

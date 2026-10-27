import type { SavedLabelColor } from '../core/model.ts'

export const EVENT_VERSION = 1 as const

export interface EventBase {
  labelColors?: SavedLabelColor[]
  v: typeof EVENT_VERSION
  seq: number
  id: string
  at: string
  actor: string
  cardId: string
  reason?: string
  details?: string
  undoes?: string
  boardId?: string
  taskId?: string
  subtaskId?: string
  agentId?: string
  sessionId?: string
  commandId?: string
  messageId?: string
}

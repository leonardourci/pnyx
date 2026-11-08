import type { EventBase } from '#store/events.ts'
import type { HydraEvent, HydraState } from '#app/model.ts'
import { sessionId } from '#workers/session-attachments.ts'
import { liveTask, taskDone } from '#tasks/select.ts'
import { steeringHeld } from '#workers/steering.ts'
import { activeHelperBatches } from '#routine-helper/state.ts'
import { nativeIdle } from '#workers/native-work.ts'
import type { NativeHealth } from './health.ts'

export const RECOVERY_ATTEMPTS = 2
export const RECOVERY_PAUSE_MS = 30_000
export const RECOVERY_WINDOW_MS = 30 * 60_000

export interface RecoveryAttempt {
  message: string
  number: number
  status: 'reserved' | 'delivered' | 'failed' | 'unknown'
  sessionId: string
  generation?: number
  at: string
}

export type RecoveryEvent = EventBase & {
  type: 'diagnostic.retry'
  data: RecoveryAttempt
}

export function recoveryNeedsNotice({ attempt }: { attempt?: RecoveryAttempt }): boolean {
  return attempt !== undefined && (attempt.status === 'reserved' || attempt.status === 'unknown'
    || (attempt.status === 'failed' && attempt.number >= RECOVERY_ATTEMPTS))
}

export const recoveryKey = ({
  task,
  message,
}: {
  task: string
  message: string
}) => JSON.stringify([
  task,
  message,
])

export function applyRecovery({
  state,
  event,
}: {
  state: HydraState
  event: HydraEvent | RecoveryEvent
}): boolean {
  if (event.type !== 'diagnostic.retry') {
    return false
  }

  const key = recoveryKey({
    task: event.cardId,
    message: event.data.message,
  })
  const attempts = state.diagnosticRetries?.[key] ?? []
  const previous = attempts.find(attempt => attempt.number === event.data.number)
  const next = attempts.filter(attempt => attempt.number !== event.data.number)

  if (previous && previous.status !== 'reserved'
    && !(previous.status === 'unknown' && event.data.status === 'delivered')) {
    return true
  }

  next.push({ ...event.data })
  next.sort((
    left,
    right,
  ) => left.number - right.number)
  state.diagnosticRetries = {
    ...state.diagnosticRetries,
    [key]: next,
  }

  return true
}

export function recoverySubjects({ state }: { state: HydraState }) {
  return Object.values(state.cards).flatMap(card => (card.replies ?? []).map(reply => ({
    card,
    reply,
    attempts: state.diagnosticRetries?.[recoveryKey({
      task: card.id,
      message: reply.id,
    })] ?? [],
  })).filter(item => item.reply.state === 'failed'
    || item.attempts.some(attempt => attempt.status === 'reserved' || attempt.status === 'unknown')))
}

export function recoveryCandidates({
  state,
  sessions,
  events,
  enabled,
  now,
}: {
  state: HydraState
  sessions: NativeHealth[]
  events: HydraEvent[]
  enabled: boolean
  now: number
}) {
  const originals = new Map<string, Extract<HydraEvent, { type: 'card.replied' }>>()

  for (const event of events) {
    if (event.type === 'card.replied') {
      const key = recoveryKey({
        task: event.cardId,
        message: event.data.reply,
      })

      if (!originals.has(key)) {
        originals.set(
          key,
          event,
        )
      }
    }
  }

  return recoverySubjects({ state }).map(({
    card,
    reply,
    attempts,
  }) => {
    const key = recoveryKey({
      task: card.id,
      message: reply.id,
    })
    const original = originals.get(key)
    const originalAt = original ? Date.parse(original.at) : Number.NaN
    const agent = card.agent
    const session = agent && sessions.find(entry => entry.sessionId === sessionId({ agent })
        && entry.taskId === card.id && entry.generation === card.steeringGeneration)
    let reason: string | undefined

    if (reply.state !== 'failed') {
      reason = 'delivery is not proven failed'
    } else if (!enabled) {
      reason = 'routine helper is unavailable'
    } else if (!liveTask({ card }) || taskDone({
      state,
      card,
    })
        || card.status?.state === 'paused' || steeringHeld({ card }) || card.mirror) {
      reason = 'task is held or no longer active'
    } else if (card.agent?.host !== 'pnyx' || !session?.attached || !session.work) {
      reason = 'native ownership is unknown'
    } else if (!original || original.sessionId !== session.sessionId
        || card.steeringGeneration === undefined || original.seq < card.steeringGeneration) {
      reason = 'the original assignment is not current'
    } else if (!Number.isFinite(originalAt) || now < originalAt
        || now - originalAt > RECOVERY_WINDOW_MS) {
      reason = 'the failed message is too old for automatic recovery'
    } else if (session.leased !== false) {
      reason = 'task ownership is leased'
    } else if (session.stale || session.inputs.length || !nativeIdle({ work: session.work })) {
      reason = 'native work is unsettled'
    } else if (activeHelperBatches({ state }).some(batch => batch.tasks.includes(card.id))) {
      reason = 'the helper still owns this task'
    } else if (card.attention.some(item => item.blocking && !item.answered)) {
      reason = 'a request is waiting for an answer'
    } else if (!original?.data.text || original.data.route !== 'pnyx'
        || original.data.state !== 'queued'
        || original.data.control || original.data.taskMessage
        || original.data.answers || original.data.accepted
        || reply.answers || reply.accepted || /^\s*\//.test(original.data.text)) {
      reason = 'the original plain message is not proven safe to resend'
    } else if (card.steering?.some(message => message.id === reply.id
        || message.reply === reply.id)) {
      reason = 'the instruction is already in the durable inbox'
    } else if (attempts.some(attempt => attempt.status === 'reserved'
        || attempt.status === 'unknown')) {
      reason = 'an earlier recovery attempt is unconfirmed'
    } else if (attempts.some(attempt => attempt.status === 'delivered')) {
      reason = 'recovery already delivered this message'
    } else if (attempts.length >= RECOVERY_ATTEMPTS) {
      reason = 'recovery budget exhausted'
    }

    return {
      taskId: card.id,
      messageId: reply.id,
      receiptState: reply.state,
      sessionId: session?.sessionId,
      generation: card.steeringGeneration,
      eligible: reason === undefined,
      reason,
      attempts,
    }
  })
}

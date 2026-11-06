import { randomUUID } from 'node:crypto'
import { enqueueSteering } from './inbox.ts'
import type { AgentRef } from './model.ts'
import type { InputReceipt } from './provider.ts'
import { decideReply } from './reply-rules.ts'
import { INTERRUPTED, sessionId } from './session-attachments.ts'
import { steeringHeld } from './steering.ts'
import type { createSteeringDelivery } from './steering-delivery.ts'
import type { createCompactionControl } from '#workers/compaction/control.ts'
import { compactCommand } from '#workers/compaction/state.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { deliveringMessage } from '#routine-helper/leases.ts'
import type { Card } from '#tasks/model.ts'
import { decidePush } from '#tasks/push.ts'
import { HydraError } from '#store/errors.ts'
import { applyDecision } from '#app/decision.ts'
import type { Live } from '#app/host-types.ts'
import type { Writer } from '#app/writer.ts'

// A message reaching a hosted agent: persisted steering or a direct input, and the direct reply settled on the provider's receipt.
export function createHostedDelivery({
  live,
  at,
  write,
  note,
  hosted,
  folderOf,
  record,
  holdCompact,
  open,
  ringSteering,
  unnotifiedSteering,
}: {
  live: Map<string, Live>
  at(): string
  write<T>({ fn }: { fn: ({ writer }: { writer: Writer }) => T }): T
  note({ fn }: { fn: ({ writer }: { writer: Writer }) => void }): void
  hosted({
    writer,
    ref,
  }: {
    writer: Writer
    ref: string
  }): Card & { agent: AgentRef }
  folderOf({ card }: { card: Card & { agent: AgentRef } }): string
  record({
    writer,
    agent,
    input,
    actor,
    eventId,
  }: {
    writer: Writer
    agent: AgentRef
    input: Record<string, unknown>
    actor: string
    eventId?: string
  }): void
  holdCompact: ReturnType<typeof createCompactionControl>['holdCompact']
  open({ card }: { card: Card & { agent: AgentRef } }): Live
  ringSteering: ReturnType<typeof createSteeringDelivery>['ringSteering']
  unnotifiedSteering: ReturnType<typeof createSteeringDelivery>['unnotifiedSteering']
}) {
  // A direct input's reply moves on from queued only on what the provider says about it.
  const directReply = ({
    card,
    inputId,
    state,
    detail,
  }: {
    card: string
    inputId: string
    state: 'delivered' | 'failed' | 'delivery_unknown'
    detail?: string
  }) => note({
    fn: ({ writer }) => {
      const reply = writer.state.cards[card]?.replies?.find(item => item.id === inputId)

      if (!reply || reply.state !== 'queued') {
        return
      }

      const data: Parameters<typeof decideReply>[0]['data'] = {
        reply: inputId,
        state,
        route: 'pnyx',
      }

      if (detail) {
        data.detail = detail
      }

      // A delivered answer marks its questions answered, as the reply's first record would have.
      if (reply.answers) {
        data.answers = reply.answers
      }

      applyDecision({
        writer,
        decision: decideReply({
          state: writer.state,
          ref: card,
          data,
          meta: {
            at: at(),
            actor: 'pnyx',
            id: `direct:${inputId}:${state}`,
          },
        }),
      })
    },
  })

  const settleDirect = ({
    entry,
    inputId,
    phase,
  }: {
    entry: Live
    inputId: string
    phase: InputReceipt['phase']
  }) => {
    const pending = entry.pendingDirect.get(inputId)

    if (!pending) {
      return
    }

    if (phase === 'taken') {
      pending.taken = true

      return
    }

    if (phase !== 'confirmed' && phase !== 'carried' && phase !== 'settled' && phase !== 'refused') {
      return
    }

    entry.pendingDirect.delete(inputId)
    directReply({
      card: pending.card,
      inputId,
      state: phase === 'refused' ? 'failed' : 'delivered',
      detail: phase === 'refused' ? 'the agent refused this message; nothing was delivered' : undefined,
    })
  }

  // eventId names the turn's working record, as a resumed turn's does.
  const send = ({
    card: ref,
    text,
    original,
    actor,
    eventId,
    steering,
    attempt,
    direct,
    inputId,
  }: {
    card: string
    text: string
    original?: string
    actor: string
    eventId?: string
    steering?: string
    attempt?: string
    direct?: boolean
    inputId?: string
  }) => {
    if (attempt !== undefined && (!attempt.trim() || !steering)) {
      throw new HydraError({
        message: 'A notification attempt needs a persisted steering ID',
        code: 'VALIDATION_ERROR',
      })
    }

    direct ||= compactCommand({ text })
    const card = deliveringMessage.run(
      true,
      () => write({
        fn: ({ writer }) => {
          const card = hosted({
            writer,
            ref,
          })

          if (!direct && card.id !== HYDRA_CARD) {
            if (steering) {
              if (!card.steering?.some(message => message.id === steering)) {
                throw new HydraError({
                  message: 'Steering message was not persisted',
                  code: 'VALIDATION_ERROR',
                })
              }
            } else {
              steering = inputId ?? randomUUID()
              enqueueSteering({
                writer,
                ref: card.id,
                id: steering,
                text,
                source: actor,
                meta: {
                  actor,
                  at: at(),
                },
              })
            }

            if (steeringHeld({ card })) {
              return writer.state.cards[card.id] as Card & { agent: AgentRef }
            }

            const current = writer.state.cards[card.id]!
            const running = live.get(sessionId({ agent: card.agent }))
            const unread = unnotifiedSteering({
              card: current,
              entry: running,
              message: steering,
              attempt,
            }).length

            if (!unread) {
              return undefined
            }
          }

          if (!live.has(sessionId({ agent: card.agent }))) {
            folderOf({ card })
          }

          if (card.attention.some(a => a.key === INTERRUPTED)) {
            const attention = card.attention.filter(a => a.key !== INTERRUPTED)
            const meta = {
              at: at(),
              actor,
            }
            const input = { attention }
            const decision = decidePush({
              state: writer.state,
              key: card.key,
              input,
              meta,
            })
            applyDecision({
              writer,
              decision,
            })
          }

          record({
            writer,
            agent: card.agent,
            input: { activity: 'working' },
            actor,
            eventId,
          })

          return writer.state.cards[card.id] as Card & { agent: AgentRef }
        },
      }),
    )

    if (!card) {
      return
    }

    if (!direct && steeringHeld({ card })) {
      return { deferred: true }
    }

    if (holdCompact({
      card,
      input: {
        id: steering ?? inputId ?? randomUUID(),
        text,
        original,
        actor,
        route: steering ? 'steering' : 'direct',
      },
    })) {
      return { queued: true }
    }

    const entry = open({ card })
    entry.activity = 'working'
    entry.sentAt = Date.now()

    if (direct || card.id === HYDRA_CARD) {
      entry.input.push({
        text,
        original,
        id: inputId,
      })

      // Its reply stays queued until the provider confirms the agent got it.
      if (inputId && card.id !== HYDRA_CARD) {
        entry.pendingDirect.set(
          inputId,
          {
            card: card.id,
            taken: false,
          },
        )

        return { pending: true }
      }
    } else {
      ringSteering({
        card,
        entry,
        message: steering,
        attempt,
      })
    }
  }

  return {
    directReply,
    settleDirect,
    send,
  }
}

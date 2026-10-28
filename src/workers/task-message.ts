import { mentionContext } from '../mentions/mentions.ts'
import { randomUUID } from 'node:crypto'
import { findCard } from '../tasks/push-rules.ts'
import { decideReply } from './reply-rules.ts'
import { hydraConfig } from '../hydra/config.ts'
import { hydraEvent } from '../hydra/hydra.ts'
import { HYDRA_CARD } from '../hydra/identity.ts'
import { liveTask } from '../tasks/select.ts'
import { HydraError } from '../store/errors.ts'
import type { ReplyState } from './model.ts'
import { withWriter } from '../app/writer.ts'
import { fmNote } from '../integrations/firstmate/reply.ts'
import { drainSpool } from '../integrations/hooks/ingest.ts'
import { sendReply, type ReplyRequest } from './reply.ts'

export interface TaskDelivery {
  state: ReplyState
  detail?: string
}
export interface TaskMessageReceipt {
  card: string
  reply: string
  state: ReplyState
  routes: {
    agent?: TaskDelivery
    hydra: TaskDelivery
  }
}

export async function sendTaskMessage({
  hydraId,
  request,
}: {
  hydraId: string
  request: Pick<ReplyRequest, 'card' | 'text' | 'id' | 'actor' | 'homes'>
}): Promise<TaskMessageReceipt> {
  if (!request.text.trim()) {
    throw new HydraError({
      message: 'message text is empty',
      code: 'VALIDATION_ERROR',
    })
  }

  const reply = request.id ?? randomUUID()
  const meta = {
    at: new Date().toISOString(),
    actor: request.actor ?? 'cli',
  }
  const target = withWriter({
    hydraId,
    fn: ({ writer }) => {
      drainSpool({ writer })
      const card = findCard({
        state: writer.state,
        ref: request.card,
      })

      if (!liveTask({ card }) || card.id === HYDRA_CARD) {
        throw new HydraError({
          message: 'choose a task for this message',
          code: 'VALIDATION_ERROR',
        })
      }

      const known = card.replies?.find(r => r.id === reply)

      const hydra = hydraConfig({
        state: writer.state,
        id: hydraId,
      }).hydra

      return {
        context: mentionContext({
          state: writer.state,
          text: request.text,
        }),
        id: card.id,
        title: card.title,
        agent: known?.route ? known.route !== 'hydra' : !!card.agent,
        session: card.sessionIds?.[0],
        receipt: known?.route && known.route !== 'hydra' ? known : undefined,
        home: hydra.kind === 'firstmate' ? hydra.home : undefined,
      }
    },
  })
  let hydra: TaskDelivery

  try {
    hydra = withWriter({
      hydraId,
      fn: ({ writer }) => {
        const id = `task-context:${target.id}:${reply}`

        if (!(id in writer.state.eventIds)) {
          const decision = hydraEvent({
            state: writer.state,
            meta: {
              ...meta,
              id,
            },
            cardId: target.id,
            change: {
              type: 'hydra.message',
              data: {
                task: target.id,
                text: request.text,
                ...(target.context ? { context: target.context } : {}),
                action: 'send',
                hydra: hydraConfig({
                  state: writer.state,
                  id: hydraId,
                }).hydra.id,
              },
            },
          })

          if ('event' in decision) {
            decision.event.messageId = reply
            writer.append({ event: decision.event })
          }
        }

        const known = writer.state.cards[target.id]?.replies?.find(r => r.id === `hydra:${reply}`)

        if (known) {
          return {
            state: known.state,
            ...(known.detail ? { detail: known.detail } : {}),
          }
        }

        const receipt = decideReply({
          state: writer.state,
          ref: target.id,
          meta: {
            ...meta,
            id: `task-context-receipt:${target.id}:${reply}`,
          },
          data: {
            reply: `hydra:${reply}`,
            state: 'queued',
            route: 'hydra',
            taskMessage: true,
          },
        })

        if ('event' in receipt) {
          writer.append({ event: receipt.event })
        }

        return { state: 'queued' as const }
      },
    })

    if (target.home && (hydra.state === 'queued' || hydra.state === 'failed')) {
      hydra = fmNote({
        home: target.home,
        requestId: `pnyx:${hydraId}:${target.id}:${reply}`,
        text: `Message on task ${target.id}: ${target.title}\n\n${[
          request.text,
          target.context,
        ].filter(Boolean).join('\n\n')}`,
      })
      const outcome = hydra
      withWriter({
        hydraId,
        fn: ({ writer }) => {
          const decision = decideReply({
            state: writer.state,
            ref: target.id,
            meta,
            data: {
              reply: `hydra:${reply}`,
              route: 'hydra',
              taskMessage: true,
              ...outcome,
            },
          })

          if ('event' in decision) {
            writer.append({ event: decision.event })
          }
        },
      })
    }
  } catch (error) {
    hydra = {
      state: 'delivery_unknown',
      detail: `Hydra receipt could not be confirmed: ${(error as Error).message}`,
    }
  }

  const record = ({
    state,
    detail,
    route,
  }: TaskDelivery & { route: string }) => withWriter({
    hydraId,
    fn: ({ writer }) => {
      const known = writer.state.cards[target.id]?.replies?.find(r => r.id === reply)
      const decision = decideReply({
        state: writer.state,
        ref: target.id,
        meta,
        data: {
          reply,
          state,
          route,
          ...(detail ? { detail } : {}),
          ...(!known ? {
            text: request.text,
            taskMessage: true,
          } : {}),
        },
      })

      if ('event' in decision) {
        writer.append({ event: decision.event })
      }
    },
  })

  let agent: TaskDelivery | undefined

  if (target.agent && target.receipt && target.receipt.state !== 'failed') {
    const {
      state,
      detail,
    } = target.receipt
    agent = {
      state,
      ...(detail ? { detail } : {}),
    }
  } else if (target.agent) {
    try {
      const receipt = await sendReply({
        hydraId,
        request: {
          ...request,
          card: target.id,
          id: reply,
          taskMessage: true,
          ...(target.session ? { expectedSession: target.session } : {}),
        },
      })
      agent = receipt.recordError ? {
        state: 'delivery_unknown',
        detail: `Send ended ${receipt.state}, but its receipt could not be saved: ${receipt.recordError}`,
      } : receipt
    } catch (error) {
      agent = {
        state: 'failed',
        detail: (error as Error).message,
      }
      record({
        ...agent,
        route: 'agent',
      })
    }
  } else {
    record({
      ...hydra,
      route: 'hydra',
    })
  }

  const routes = {
    ...(agent ? { agent } : {}),
    hydra,
  }
  const states = Object.values(routes).map(r => r.state)
  const state = states.includes('failed') ? 'failed' : states.includes('delivery_unknown') ? 'delivery_unknown' : states.includes('queued') ? 'queued' : 'delivered'

  return {
    card: target.id,
    reply,
    state,
    routes,
  }
}

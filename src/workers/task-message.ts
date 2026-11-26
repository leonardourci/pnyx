import { mentionContext } from '#titan/mentions.ts'
import { randomUUID } from 'node:crypto'
import { findCard } from '#tasks/push-rules.ts'
import { decideReply } from './reply-rules.ts'
import { hydraConfig } from '#titan/config.ts'
import { hydraEvent } from '#titan/titan.ts'
import { TITAN_CARD } from '#titan/identity.ts'
import { inform } from '#app/command-notices.ts'
import { TitanError } from '#store/errors.ts'
import type { ReplyState } from './model.ts'
import { withWriter } from '#app/writer.ts'
import { drainSpool } from '#integrations/hooks/ingest.ts'
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
  titanId,
  request,
}: {
  titanId: string
  request: Pick<ReplyRequest, 'card' | 'text' | 'id' | 'actor'>
}): Promise<TaskMessageReceipt> {
  if (!request.text.trim()) {
    throw new TitanError({
      message: 'message text is empty',
      code: 'VALIDATION_ERROR',
    })
  }

  const reply = request.id ?? randomUUID()
  const meta = {
    at: new Date().toISOString(),
    actor: request.actor ?? 'cli',
  }
  const target = await withWriter({
    titanId,
    fn: ({ writer }) => {
      drainSpool({ writer })
      const card = findCard({
        state: writer.state,
        ref: request.card,
      })

      if (card.id === TITAN_CARD) {
        throw new TitanError({
          message: 'choose a task for this message',
          code: 'VALIDATION_ERROR',
        })
      }

      if (card.hidden) {
        inform({
          task: card.id,
          reason: 'Message sent to a hidden task',
          clear: `Review the visibility of task ${card.id} in the UI.`,
        })
      }

      const known = card.replies?.find(r => r.id === reply)

      return {
        context: mentionContext({
          state: writer.state,
          text: request.text,
        }),
        id: card.id,
        agent: known?.route ? known.route !== 'hydra' : !!card.agent,
        session: card.sessionIds?.[0],
        receipt: known?.route && known.route !== 'hydra' ? known : undefined,
      }
    },
  })
  let hydra: TaskDelivery

  try {
    hydra = await withWriter({
      titanId,
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
              type: 'titan.message',
              data: {
                task: target.id,
                text: request.text,
                ...(target.context ? { context: target.context } : {}),
                action: 'send',
                hydra: hydraConfig({
                  state: writer.state,
                  id: titanId,
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
  } catch (error) {
    hydra = {
      state: 'delivery_unknown',
      detail: `Titan receipt could not be confirmed: ${(error as Error).message}`,
    }
  }

  const record = async ({
    state,
    detail,
    route,
  }: TaskDelivery & { route: string }) => await withWriter({
    titanId,
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
        titanId,
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
      await record({
        ...agent,
        route: 'agent',
      })
    }
  } else {
    await record({
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

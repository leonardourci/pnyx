import type { Writer } from '#app/writer.ts'
import type { Card } from '#tasks/model.ts'
import { applyDecision } from '#app/decision.ts'
import { ownerActor } from '#app/actors.ts'
import { decideReply } from './reply-rules.ts'

// The owner's own steering the agent has not read; Hydra's and Pnyx's steering is not the owner's to cancel.
export const unreadOwnerSteering = ({ card }: { card: Card }) => (card.steering ?? [])
  .filter(message => !message.ack && !message.stopped && ownerActor({ actor: message.source }))

export function stopWorkerInputs({
  writer,
  card,
  ids,
  at,
}: {
  writer: Writer
  card: Card
  ids: readonly string[]
  at: string
}) {
  const messages = unreadOwnerSteering({ card }).filter(message => ids.includes(message.id))

  if (!messages.length) {
    return
  }

  writer.append({
    event: {
      v: 1,
      seq: writer.state.seq + 1,
      id: `stop:${card.id}:${writer.state.seq}`,
      cardId: card.id,
      actor: 'pnyx',
      at,
      type: 'task.steering.stopped',
      data: { messages: messages.map(message => message.id) },
    },
  })

  for (const message of messages) {
    const reply = card.replies?.find(reply => reply.id === message.reply)

    if (reply) {
      applyDecision({
        writer,
        decision: decideReply({
          state: writer.state,
          ref: card.id,
          data: {
            reply: reply.id,
            state: 'failed',
            route: 'pnyx',
            detail: 'stopped',
          },
          meta: {
            actor: 'pnyx',
            at,
          },
        }),
      })
    }
  }
}

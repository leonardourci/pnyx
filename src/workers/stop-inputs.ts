import type { Writer } from '#app/writer.ts'
import type { Card } from '#tasks/model.ts'
import { applyDecision } from '#app/decision.ts'
import { decideReply } from './reply-rules.ts'
import { pendingSteering } from './steering.ts'

export function cancelWorkerInputs({
  writer,
  card,
  at,
}: {
  writer: Writer
  card: Card
  at: string
}) {
  const messages = pendingSteering({ card })

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
      type: 'task.steering.cancelled',
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

import { HYDRA_CARD } from '../src/core/hydra.ts'
import { acknowledgeSteering, inboxTask, requireSteeringWorker } from '../src/task-inbox/inbox.ts'
import { steeringClaim } from '../src/task-inbox/state.ts'
import { withWriter } from '../src/store/hydra-store.ts'

export function incorporateInboxNotice({
  text,
  env,
}: {
  text: string
  env: NodeJS.ProcessEnv
}): string {
  if (!text.startsWith('Pnyx steering inbox has pending instruction IDs ')) {
    return text
  }

  const actor = env.PNYX_ACTOR
  const hydraId = env.PNYX_HYDRA

  if (!actor?.startsWith('worker:') || !hydraId) {
    throw new Error('Inbox notice requires a worker environment')
  }

  const ref = actor.slice('worker:'.length)

  if (ref === HYDRA_CARD) {
    throw new Error('Hydra does not use a worker inbox')
  }

  return withWriter({
    hydraId,
    fn: ({ writer }) => {
      const card = inboxTask({
        writer,
        ref,
      })
      requireSteeringWorker({
        state: writer.state,
        card,
        actor,
        worker: env.PNYX_STEERING_WORKER,
      })
      const claim = steeringClaim({ card })

      if (!claim) {
        throw new Error('Inbox notice requires an attached worker')
      }

      const messages = (card.steering ?? []).filter(message => !message.ack)

      for (const message of messages) {
        acknowledgeSteering({
          writer,
          ref,
          id: message.id,
          ack: {
            actor,
            at: new Date().toISOString(),
            claim,
            outcome: 'incorporated',
          },
          meta: {
            actor,
            at: new Date().toISOString(),
          },
          worker: env.PNYX_STEERING_WORKER,
        })
      }

      return messages.map(message => message.text).join('\n\n')
    },
  })
}

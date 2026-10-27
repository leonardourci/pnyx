import { HYDRA_CARD } from '../core/hydra.ts'
import { acknowledgeSteering, inboxTask, requireSteeringWorker } from '../task-inbox/inbox.ts'
import { pendingSteering, steeringClaim } from '../task-inbox/state.ts'
import { withWriter } from '../app/writer.ts'

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

  const notice = /^Pnyx steering inbox has pending instruction IDs (\[[^\n]*?\])\. Run `pnyx-axi task inbox read (\S+) --hydra (\S+)`/.exec(text)

  if (!notice) {
    throw new Error('Malformed steering notice')
  }

  const ids: unknown = JSON.parse(notice[1]!)

  if (!Array.isArray(ids) || !ids.length || !ids.every(id => typeof id === 'string')) {
    throw new Error('Malformed steering IDs')
  }

  const ref = actor.slice('worker:'.length)

  if (notice[2] !== ref || notice[3] !== hydraId) {
    throw new Error('Notice targets another task or Hydra')
  }

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

      if (!ids.every(id => card.steering?.some(message => message.id === id))) {
        throw new Error('Notice names an unknown steering ID')
      }

      const messages = pendingSteering({ card }).filter(message => ids.includes(message.id))

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

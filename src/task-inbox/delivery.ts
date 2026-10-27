import { HOOK } from '../integrations/hooks/observe.ts'
import { replyRoute } from '../core/route.ts'
import { drainSpool } from '../integrations/hooks/ingest.ts'
import { terminalNotice, typeInto } from '../integrations/hooks/terminal.ts'
import type { Connect } from '../integrations/paseo/client.ts'
import { paseoNotice } from '../integrations/paseo/reply.ts'
import { askHost } from '../server/state.ts'
import { loadHydra } from '../app/store.ts'
import { withWriter } from '../app/writer.ts'
import { recordSteeringAttempt } from './inbox.ts'
import { steeringNotice, type NotificationResult } from './notice.ts'
import { sameClaim, steeringClaim, steeringHeld } from './state.ts'

export async function notifySteering({
  hydraId,
  card: cardId,
  message: messageId,
  attempt,
  now = Date.now(),
  connectPaseo,
}: {
  hydraId: string
  card: string
  message: string
  attempt: string
  now?: number
  connectPaseo?: Connect
}): Promise<NotificationResult> {
  const card = loadHydra({ hydraId }).state.cards[cardId]
  const message = card?.steering?.find(message => message.id === messageId)
  const claim = card && steeringClaim({ card })

  if (!card || !message || message.ack) {
    return {
      result: 'deferred',
      detail: 'instruction already handled or removed',
    }
  }

  if (steeringHeld({ card })) {
    return {
      result: 'deferred',
      detail: 'task is intentionally held; release the hold before notifying',
    }
  }

  if (!claim) {
    return {
      result: 'gone',
      detail: 'task has no assigned worker; attach a worker to read its inbox',
    }
  }

  const known = message.attempts.find(known => known.id === attempt)

  if (known) {
    return {
      result: known.result,
      detail: known.detail,
    }
  }

  const canSend = () => withWriter({
    hydraId,
    fn: ({ writer }) => {
      drainSpool({ writer })
      const current = writer.state.cards[cardId]
      const pending = current?.steering?.find(message => message.id === messageId)

      if (!current || current.mirror || current.sourceRefs.some(source => source.adapter === 'firstmate')) {
        return false
      }

      const waiting = current.attention.some(request =>
        request.blocking && !request.answered && request.key.startsWith(HOOK))
      const active = !current.hidden && !steeringHeld({ card: current }) && !waiting

      return Boolean(active && pending && !pending.ack
        && sameClaim({
          current: steeringClaim({ card: current }),
          claim,
        }))
    },
  })
  const found = replyRoute({
    card,
    homes: [],
  })
  let outcome: NotificationResult

  if ('reason' in found) {
    outcome = {
      result: 'gone',
      detail: found.reason,
    }
  } else {
    const route = found.route
    const text = steeringNotice({
      task: card.id,
      hydraId,
      ids: [message.id],
    })

    if (route.kind === 'pnyx') {
      try {
        const accepted = await askHost({
          hydraId,
          body: {
            action: 'send',
            card: card.id,
            steering: message.id,
            attempt,
            actor: 'pnyx',
          },
        })
        outcome = accepted.deferred
          ? {
            result: 'deferred',
            detail: 'host deferred notification while the worker is held',
          }
          : { result: 'delivered' }
      } catch (error) {
        outcome = {
          result: 'unknown',
          detail: `host did not confirm notification: ${(error as Error).message}`,
        }
      }
    } else if (route.kind === 'firstmate') {
      return {
        result: 'gone',
        detail: 'Firstmate owns this task’s inbox; use fm-send',
      }
    } else if (route.kind === 'paseo-agent' && card.attention.some(request =>
      request.blocking && !request.answered && request.key.startsWith(HOOK))) {
      outcome = {
        result: 'deferred',
        detail: 'worker is waiting on a permission or question; answer it before notifying',
      }
    } else if (route.kind === 'paseo-agent') {
      outcome = await paseoNotice({
        route,
        text,
        id: attempt,
        canSend,
        connect: connectPaseo,
      })
    } else {
      outcome = terminalNotice({
        route,
        text,
        card,
        send: ({
          route,
          text,
        }) => canSend()
          ? typeInto({
            route,
            text,
          })
          : {
            state: 'failed',
            detail: 'instruction was handled, held or reassigned; nothing was typed',
          },
      })
    }
  }

  withWriter({
    hydraId,
    fn: ({ writer }) => {
      const current = writer.state.cards[cardId]
      const pending = current?.steering?.find(message => message.id === messageId)

      if (!current || !pending || pending.ack || !sameClaim({
        current: steeringClaim({ card: current }),
        claim,
      })) {
        return
      }

      recordSteeringAttempt({
        writer,
        ref: cardId,
        id: messageId,
        attempt: {
          id: attempt,
          at: new Date(now).toISOString(),
          actor: 'pnyx',
          claim,
          result: outcome.result === 'gone' ? 'failed' : outcome.result,
          detail: outcome.detail,
        },
        meta: {
          at: new Date(now).toISOString(),
          actor: 'pnyx',
        },
      })
    },
  })

  return outcome
}

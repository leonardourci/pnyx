import { commentInput } from '#workers/compaction/comments.ts'
import { pendingSteering, steeringClaim } from './steering.ts'
import { readFileSync } from 'node:fs'
import { integer, meta, parse, required, COMMON, type Output } from '#app/cli-support.ts'
import { HydraError } from '#store/errors.ts'
import type { SteeringAck, SteeringAttempt, SteeringClaim } from './model.ts'
import { loadHydra } from '#app/store.ts'
import { withWriter, type Writer } from '#app/writer.ts'
import { acknowledgeSteering, enqueueSteering, inboxTask, recordSteeringAttempt, requireSteeringWorker } from './inbox.ts'

export function inboxCommand({ args }: { args: string[] }): Output {
  const {
    values,
    positionals,
    hydraId,
  } = parse({
    args,
    positionals: 3,
    options: {
      ...COMMON,
      actor: { type: 'string' },
      reason: { type: 'string' },
      text: { type: 'string' },
      file: { type: 'string' },
      source: { type: 'string' },
      reply: { type: 'string' },
      session: { type: 'string' },
      generation: { type: 'string' },
      outcome: { type: 'string' },
      note: { type: 'string' },
      attempt: { type: 'string' },
      result: { type: 'string' },
      all: { type: 'boolean' },
    },
  })
  const action = positionals[0]
  const ref = required({
    value: positionals[1],
    what: 'task',
  })
  const actor = meta({ values })

  if (action === 'read') {
    const read = ({ writer }: { writer: Pick<Writer, 'state'> }) => {
      const card = inboxTask({
        writer,
        ref,
      })
      const messages = card.steering ?? []
      const selected = values.all ? messages : pendingSteering({ card })

      return {
        task: card.id,
        claim: steeringClaim({ card }) ?? 'none: no active worker',
        messages: selected.length ? selected.map(message => ({
          ...message,
          text: commentInput({
            card,
            id: message.id,
            text: message.text,
          }),
        })) : 'none: no pending steering',
        pending: messages.filter(message => !message.ack).length,
      }
    }

    if (!actor.actor.startsWith('worker:')) {
      return read({ writer: { state: loadHydra({ hydraId }).state } })
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
          actor: actor.actor,
          worker: process.env.PNYX_STEERING_WORKER,
        })
        const output = read({ writer })
        const claim = steeringClaim({ card })

        if (!claim) {
          throw new HydraError({
            message: 'Reading as a worker requires an active inbox assignment',
            code: 'STALE_CLAIM',
          })
        }

        for (const message of pendingSteering({ card })) {
          acknowledgeSteering({
            writer,
            ref,
            id: message.id,
            ack: {
              at: actor.at,
              actor: actor.actor,
              claim,
              outcome: 'read',
            },
            meta: actor,
            worker: process.env.PNYX_STEERING_WORKER,
          })
        }

        const current = inboxTask({
          writer,
          ref,
        })
        output.pending = (current.steering ?? []).filter(message => !message.ack).length

        return output
      },
    })
  }

  if (![
    'enqueue',
    'ack',
    'notify',
  ].includes(action ?? '')) {
    throw new HydraError({
      message: 'Use task inbox read|enqueue|ack|notify <task> [message]',
      code: 'VALIDATION_ERROR',
    })
  }

  const id = required({
    value: positionals[2],
    what: 'message id',
  })

  let text = values.text as string | undefined

  if (action === 'enqueue') {
    if (values.text !== undefined && values.file !== undefined) {
      throw new HydraError({
        message: 'Pass --text or --file, not both',
        code: 'VALIDATION_ERROR',
      })
    }

    if (typeof values.file === 'string') {
      text = readFileSync(
        values.file === '-' ? 0 : values.file,
        'utf8',
      )
    }
  }

  return withWriter({
    hydraId,
    fn: ({ writer }) => {
      if (action === 'enqueue') {
        const message = enqueueSteering({
          writer,
          ref,
          id,
          text: required({
            value: text,
            what: '--text or --file',
          }),
          source: values.source as string | undefined ?? actor.actor,
          reply: values.reply as string | undefined,
          meta: actor,
        })

        return {
          task: inboxTask({
            writer,
            ref,
          }).id,
          message,
        }
      }

      const claim: SteeringClaim = {
        session: required({
          value: values.session as string | undefined,
          what: '--session',
        }),
        generation: integer({
          value: required({
            value: values.generation as string | undefined,
            what: '--generation',
          }),
          flag: '--generation',
        })!,
      }
      const note = values.note as string | undefined

      if (action === 'ack') {
        const outcome = values.outcome ?? 'read'

        if (outcome !== 'read' && outcome !== 'incorporated' && outcome !== 'blocked') {
          throw new HydraError({
            message: '--outcome takes read, incorporated or blocked',
            code: 'VALIDATION_ERROR',
          })
        }

        const ack: SteeringAck = {
          at: actor.at,
          actor: actor.actor,
          claim,
          outcome,
        }

        if (note !== undefined) {
          ack.note = note
        }

        return {
          message: acknowledgeSteering({
            writer,
            ref,
            id,
            ack,
            meta: actor,
            worker: process.env.PNYX_STEERING_WORKER,
          }),
        }
      }

      const result = values.result

      if (result !== 'delivered' && result !== 'unknown' && result !== 'failed' && result !== 'deferred') {
        throw new HydraError({
          message: '--result takes delivered, unknown, failed or deferred',
          code: 'VALIDATION_ERROR',
        })
      }

      const attempt: SteeringAttempt = {
        id: required({
          value: values.attempt as string | undefined,
          what: '--attempt',
        }),
        at: actor.at,
        actor: actor.actor,
        claim,
        result,
      }

      if (note !== undefined) {
        attempt.detail = note
      }

      return {
        message: recordSteeringAttempt({
          writer,
          ref,
          id,
          attempt,
          meta: actor,
        }),
      }
    },
  })
}

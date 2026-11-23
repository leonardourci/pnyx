import { nativeHome } from '#app/native-home.ts'
import { workerIdentity } from './worker-identity.ts'
import { pendingSteering, steeringClaim } from './steering.ts'
import { readInput } from '#app/request-context.ts'
import { integer, meta, parse, required, COMMON, type Options, type Output } from '#app/cli-support.ts'
import { HydraError } from '#store/errors.ts'
import type { SteeringAck, SteeringAttempt, SteeringClaim } from './model.ts'
import { loadHydra } from '#app/store.ts'
import { withWriter, type Writer } from '#app/writer.ts'
import { acknowledgeSteering, enqueueSteering, inboxTask, recordSteeringAttempt, requireSteeringWorker } from './inbox.ts'
import { requestEnv } from '#app/request-context.ts'

export const INBOX_OPTIONS: Options = {
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
}

export async function inboxCommand({ args }: { args: string[] }): Promise<Output> {
  const {
    values,
    positionals,
    hydraId,
  } = parse({
    args,
    positionals: 3,
    options: INBOX_OPTIONS,
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
        messages: selected.length ? selected : 'none: no pending steering',
        pending: messages.filter(message => !message.ack).length,
      }
    }

    if (!actor.actor.startsWith('worker:')) {
      return read({ writer: { state: loadHydra({ hydraId }).state } })
    }

    return await withWriter({
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
          worker: requestEnv().PNYX_STEERING_WORKER,
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
            worker: requestEnv().PNYX_STEERING_WORKER,
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
      text = readInput({ file: values.file })
    }
  }

  return await withWriter({
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
            worker: requestEnv().PNYX_STEERING_WORKER,
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

export async function acknowledgeInstruction({ args }: { args: string[] }): Promise<Output> {
  const {
    values,
    positionals,
    hydraId,
  } = parse({
    args,
    positionals: 2,
    options: {
      ...COMMON,
      session: { type: 'string' },
      generation: { type: 'string' },
    },
  })
  const ref = required({
    value: positionals[0],
    what: 'task',
  })
  const id = required({
    value: positionals[1],
    what: 'instruction id',
  })
  const session = required({
    value: values.session as string | undefined,
    what: '--session',
  })
  const encoded = required({
    value: values.generation as string | undefined,
    what: '--generation',
  })
  let reference: unknown

  try {
    reference = JSON.parse(encoded)
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error
    }
  }

  if (!reference || typeof reference !== 'object' || !('native' in reference)
    || typeof reference.native !== 'string' || Object.keys(reference).length !== 1) {
    throw new HydraError({
      code: 'VALIDATION_ERROR',
      message: '--generation needs the native assignment reference from the notice or task record',
    })
  }

  const assignment = reference.native
  const m = meta({ values })
  const identity = workerIdentity({ actor: m.actor })

  return await withWriter({
    hydraId,
    fn: ({ writer }) => {
      const card = inboxTask({
        writer,
        ref,
      })

      if (identity?.task !== card.id || m.actor !== `worker:${card.id}`) {
        throw new HydraError({
          code: 'VALIDATION_ERROR',
          message: 'Only the assigned worker may acknowledge its own instruction IDs',
        })
      }

      const generation = nativeHome().references({ hydra: hydraId })
        .get(assignment)

      if (generation === undefined) {
        throw new HydraError({
          code: 'STALE_CLAIM',
          message: 'This assignment no longer belongs to the task’s inbox',
        })
      }

      if (card.steering?.find(message => message.id === id)?.stopped) {
        throw new HydraError({
          code: 'STALE_CLAIM',
          message: 'This instruction was cancelled before it was read',
        })
      }

      const acknowledged = acknowledgeSteering({
        writer,
        ref: card.id,
        id,
        ack: {
          at: m.at,
          actor: m.actor,
          claim: {
            session,
            generation,
          },
          outcome: 'read',
        },
        meta: m,
        worker: requestEnv().PNYX_STEERING_WORKER,
      })

      return {
        task: card.id,
        instruction: id,
        acknowledged: acknowledged.ack?.outcome,
      }
    },
  })
}

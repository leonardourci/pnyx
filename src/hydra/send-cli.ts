import { meta, required, commit, integer, HISTORY_LIMIT, HISTORY_MAX, type Output } from '#app/cli-support.ts'
import { loadHydra } from '#app/store.ts'
import { scanEvents } from '#app/event-log.ts'
import { readServer, askHost } from '#app/server-state.ts'
import { HYDRA_ACTOR, ownerActor } from '#app/actors.ts'
import { HydraError } from '#store/errors.ts'
import { liveTask } from '#tasks/select.ts'
import { findCard } from '#tasks/push-rules.ts'
import { effectiveDispatch } from '#workers/dispatch-config.ts'
import { hydraConfig } from './config.ts'
import { hydraCandidate } from './agent-choice.ts'
import { hydraEvent, reportActor, hydraDelivery } from './hydra.ts'
import { mentionContext } from './mentions.ts'
import { resolveSkillReferences } from './skill-invocation.ts'
import { withWriter } from '#app/writer.ts'
import { applyDecision } from '#app/decision.ts'
import { HYDRA_CARD } from './identity.ts'
import { failHydraInput } from './received.ts'

export async function hydraSend({
  values,
  hydraId,
}: {
  values: Record<string, string | boolean | undefined>
  hydraId: string
}): Promise<Output> {
  const m = meta({ values })

  const ref = values.task === undefined ? undefined : required({
    value: values.task as string,
    what: '--task',
  })

  if (!ref && values.action !== undefined) {
    throw new HydraError({
      message: '--action needs --task',
      code: 'VALIDATION_ERROR',
    })
  }

  if (values.kind !== undefined && values.kind !== 'progress') {
    throw new HydraError({
      message: '--kind must be progress',
      code: 'VALIDATION_ERROR',
    })
  }

  const progress = values.kind === 'progress'

  const misused = !ref || !reportActor({ actor: m.actor }) || values.action !== undefined
    || values.text === undefined

  if (progress && misused) {
    throw new HydraError({
      message: '--kind progress is an agent\'s report: pass --task and --text, no --action, and --actor worker:<task> when PNYX_ACTOR is unset',
      code: 'VALIDATION_ERROR',
    })
  }

  // Read before the Hydra writer, so the shared registry lock is never taken inside it.
  const effective = effectiveDispatch()
  const result = await commit({
    hydraId,
    meta: m,
    intent: {
      type: 'hydra.message',
      card: ref ?? '$board',
    },
    decide: ({ state }) => {
      const task = ref ? findCard({
        state,
        ref,
      }) : undefined

      if (task && !liveTask({ card: task })) {
        throw new HydraError({
          message: 'choose a task, not an unassigned session',
          code: 'VALIDATION_ERROR',
        })
      }

      const action = String(values.action ?? 'send')

      if (action !== 'send' && action !== 'worker') {
        throw new HydraError({
          message: '--action must be send or worker',
          code: 'VALIDATION_ERROR',
        })
      }

      const entered = task
        ? String(values.text ?? `${action === 'worker' ? 'Create a worker for' : 'Work with me on'} task ${task.id}: ${task.title}. Read its task.log and worker.log before continuing.`)
        : required({
          value: values.text as string | undefined,
          what: '--text',
        })
      const provider = hydraCandidate({
        state,
        dispatch: effective.dispatch,
      }).harness
      const text = resolveSkillReferences({
        text: entered,
        provider,
      })
      const context = mentionContext({
        state,
        text,
      })
      const decision = hydraEvent({
        state,
        meta: m,
        cardId: task?.id ?? '$board',
        change: {
          type: 'hydra.message',
          data: {
            ...(task ? { task: task.id } : {}),
            action,
            ...(progress ? { kind: 'progress' as const } : {}),
            text,
            ...(text !== entered ? { enteredText: entered } : {}),
            ...(m.details ? { details: m.details } : {}),
            ...(context ? { context } : {}),
            hydra: hydraConfig({
              state,
              id: hydraId,
            }).hydra.id,
          },
        },
      })

      if ('event' in decision) {
        decision.event.messageId = decision.event.id
      }

      return decision
    },
  })

  if (progress && !result.duplicate) {
    return {
      ...result,
      help: ['Progress recorded on the card; Hydra reads it on its next wake. Send actionable results with hydra send --task <id> --text <result> (omit --kind progress); questions use task ask, blockers use worker.log'],
    }
  }

  if (m.actor === HYDRA_ACTOR || typeof result.message !== 'string') {
    return result
  }

  const message = loadHydra({ hydraId }).state.hydraMessages
    ?.find(message => message.id === result.message)

  if (!message) {
    return result
  }

  if (result.duplicate && (!message.failure || !ownerActor({ actor: m.actor }))) {
    return result
  }

  if (!await readServer({ hydraId })) {
    return result
  }

  if (result.duplicate) {
    const claimed = await withWriter({
      hydraId,
      fn: ({ writer }) => {
        const current = writer.state.hydraMessages?.find(input => input.id === message.id)

        if (!current?.failure || current.stopped) {
          return false
        }

        applyDecision({
          writer,
          decision: hydraEvent({
            state: writer.state,
            cardId: HYDRA_CARD,
            meta: {
              actor: m.actor,
              at: m.at,
            },
            change: {
              type: 'hydra.input',
              data: {
                message: message.id,
                state: 'retrying',
              },
            },
          }),
        })

        return true
      },
    })

    if (!claimed) {
      return result
    }
  }

  try {
    const hosted = await askHost({
      hydraId,
      body: {
        action: 'hydra',
        id: message.id,
        text: hydraDelivery({ message }),
        actor: m.actor,
      },
    })

    return {
      ...result,
      ...hosted,
      help: ['The Pnyx server runs Hydra; replies and startup errors appear in its chat'],
    }
  } catch (error) {
    await withWriter({
      hydraId,
      fn: ({ writer }) => failHydraInput({
        writer,
        input: message.id,
        error: (error as Error).message,
        at: new Date().toISOString(),
      }),
    })
    throw error
  }
}

export function hydraMessages({
  values,
  hydraId,
}: {
  values: Record<string, string | boolean | undefined>
  hydraId: string
}): Output {
  const state = loadHydra({ hydraId }).state
  const after = integer({
    value: values.after,
    flag: '--after',
  }) ?? 0
  const limit = Math.min(
    integer({
      value: values.limit,
      flag: '--limit',
    }) ?? HISTORY_LIMIT,
    HISTORY_MAX,
  )

  if (limit < 1) {
    throw new HydraError({
      message: '--limit must be positive',
      code: 'VALIDATION_ERROR',
    })
  }

  const events = []

  for (const event of scanEvents({
    hydraId,
    after,
    types: [
      'hydra.message',
      'task.reminder-due',
    ],
  })) {
    if (event.type === 'task.reminder-due' && event.data.grouped) {
      continue
    }

    events.push(event)

    if (events.length === limit) {
      break
    }
  }

  const through = events.at(-1)?.seq ?? after

  return {
    hydra: hydraConfig({
      state,
      id: hydraId,
    }).hydra.id,
    messages: events.length
      ? events.map(e => {
        if (e.type !== 'hydra.message' && e.type !== 'task.reminder-due') {
          throw new Error(`Unexpected ${e.type} in Hydra messages`)
        }

        const data = e.type === 'task.reminder-due' ? e.data.message : e.data

        return values.full ? e : {
          seq: e.seq,
          id: e.id,
          at: e.at,
          actor: e.actor,
          task: data.task ?? 'none',
          action: data.action,
          text: data.text,
          ...(data.details ? { details: data.details } : {}),
          ...('context' in data && data.context ? { context: data.context } : {}),
        }
      })
      : `none: no messages after seq ${after}`,
    through,

  }
}

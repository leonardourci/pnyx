import { meta, required, commit, integer, HISTORY_LIMIT, HISTORY_MAX, type Output } from '#app/cli-support.ts'
import { loadTitan } from '#app/store.ts'
import { scanEvents } from '#app/event-log.ts'
import { readServer, askHost } from '#app/server-state.ts'
import { TITAN_ACTOR, ownerActor } from '#app/actors.ts'
import { TitanError } from '#store/errors.ts'
import { liveTask } from '#tasks/select.ts'
import { findCard } from '#tasks/push-rules.ts'
import { effectiveDispatch } from '#workers/dispatch-config.ts'
import { hydraConfig } from './config.ts'
import { hydraCandidate } from './agent-choice.ts'
import { hydraEvent, hydraDelivery } from './titan.ts'
import { mentionContext } from './mentions.ts'
import { resolveSkillReferences } from './skill-invocation.ts'
import { withWriter } from '#app/writer.ts'
import { applyDecision } from '#app/decision.ts'
import { TITAN_CARD } from './identity.ts'
import { failTitanInput } from './received.ts'

export async function hydraSend({
  values,
  titanId,
}: {
  values: Record<string, string | boolean | undefined>
  titanId: string
}): Promise<Output> {
  const m = meta({ values })

  const ref = values.task === undefined ? undefined : required({
    value: values.task as string,
    what: '--task',
  })

  if (!ref && values.action !== undefined) {
    throw new TitanError({
      message: '--action needs --task',
      code: 'VALIDATION_ERROR',
    })
  }

  // Read before the Titan writer, so the shared registry lock is never taken inside it.
  const effective = effectiveDispatch()
  const result = await commit({
    titanId,
    meta: m,
    intent: {
      type: 'titan.message',
      card: ref ?? '$all',
    },
    decide: ({ state }) => {
      const task = ref ? findCard({
        state,
        ref,
      }) : undefined

      if (task && !liveTask({ card: task })) {
        throw new TitanError({
          message: 'choose a task, not an unassigned session',
          code: 'VALIDATION_ERROR',
        })
      }

      const action = String(values.action ?? 'send')

      if (action !== 'send' && action !== 'worker') {
        throw new TitanError({
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
        cardId: task?.id ?? '$all',
        change: {
          type: 'titan.message',
          data: {
            ...(task ? { task: task.id } : {}),
            action,
            text,
            ...(text !== entered ? { enteredText: entered } : {}),
            ...(m.details ? { details: m.details } : {}),
            ...(context ? { context } : {}),
            hydra: hydraConfig({
              state,
              id: titanId,
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

  if (m.actor === TITAN_ACTOR || typeof result.message !== 'string') {
    return result
  }

  const message = loadTitan({ titanId }).state.hydraMessages
    ?.find(message => message.id === result.message)

  if (!message) {
    return result
  }

  if (result.duplicate && (!message.failure || !ownerActor({ actor: m.actor }))) {
    return result
  }

  if (!await readServer({ titanId })) {
    return result
  }

  if (result.duplicate) {
    const claimed = await withWriter({
      titanId,
      fn: ({ writer }) => {
        const current = writer.state.hydraMessages?.find(input => input.id === message.id)

        if (!current?.failure || current.stopped) {
          return false
        }

        applyDecision({
          writer,
          decision: hydraEvent({
            state: writer.state,
            cardId: TITAN_CARD,
            meta: {
              actor: m.actor,
              at: m.at,
            },
            change: {
              type: 'titan.input',
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
      titanId,
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
      help: ['The Othrys server runs Titan; replies and startup errors appear in its chat'],
    }
  } catch (error) {
    await withWriter({
      titanId,
      fn: ({ writer }) => failTitanInput({
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
  titanId,
}: {
  values: Record<string, string | boolean | undefined>
  titanId: string
}): Output {
  const state = loadTitan({ titanId }).state
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
    throw new TitanError({
      message: '--limit must be positive',
      code: 'VALIDATION_ERROR',
    })
  }

  const events = []

  for (const event of scanEvents({
    titanId,
    after,
    types: [
      'titan.message',
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
      id: titanId,
    }).hydra.id,
    messages: events.length
      ? events.map(e => {
        if (e.type !== 'titan.message' && e.type !== 'task.reminder-due') {
          throw new Error(`Unexpected ${e.type} in Titan messages`)
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

import { meta, required, commit, integer, HISTORY_LIMIT, HISTORY_MAX, type Output } from '#app/cli-support.ts'
import { loadHydra } from '#app/store.ts'
import { readEvents } from '#app/event-log.ts'
import { readServer, askHost } from '#app/server-state.ts'
import { HYDRA_ACTOR } from '#app/actors.ts'
import { HydraError } from '#store/errors.ts'
import { liveTask } from '#tasks/select.ts'
import { findCard } from '#tasks/push-rules.ts'
import { effectiveDispatch } from '#workers/dispatch-config.ts'
import { upgradeCommand, restartCommand } from '#upgrade/model.ts'
import { hydraConfig } from './config.ts'
import { hydraEvent, reportActor, hydraDelivery } from './hydra.ts'
import { mentionContext } from './mentions.ts'
import { HYDRA_CARD } from './identity.ts'
import { resolveSkillReferences } from './skill-invocation.ts'

export function hydraSend({
  values,
  hydraId,
}: {
  values: Record<string, string | boolean | undefined>
  hydraId: string
}): Output | Promise<Output> {
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
  const result = commit({
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
        ? String(values.text ?? `${action === 'worker' ? 'Create a worker for' : 'Work with me on'} task ${task.id}: ${task.title}. Read its task history and current record before continuing.`)
        : required({
          value: values.text as string | undefined,
          what: '--text',
        })
      const config = hydraConfig({
        state,
        id: hydraId,
      })
      const provider = config.hydra.agent?.harness
        ?? effective.dispatch.rules.hydra?.candidates[0]?.harness
        ?? effective.dispatch.default[0]?.harness
        ?? state.cards[HYDRA_CARD]?.agent?.provider
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

  const config = hydraConfig({
    state: loadHydra({ hydraId }).state,
    id: hydraId,
  })

  if (progress && result.event !== 'none: duplicate') {
    return {
      ...result,
      help: ['Progress recorded on the card; Hydra reads it on its next wake. Send actionable results with hydra send --task <id> --text <result> (omit --kind progress); questions use task ask, blockers use task status blocked'],
    }
  }

  // Pnyx runs its own commands even for a Firstmate-linked Hydra.
  const pnyxRuns = config.hydra.kind !== 'firstmate' || upgradeCommand({ text: String(values.text ?? '') })
    || restartCommand({ text: String(values.text ?? '') })

  if (!pnyxRuns || m.actor === HYDRA_ACTOR || result.event === 'none: duplicate' || !result.message) {
    return result
  }

  const message = loadHydra({ hydraId }).state.hydraMessages
    ?.find(message => message.id === result.message)
  const text = message ? hydraDelivery({ message }) : String(values.text ?? '')

  return readServer({ hydraId }).then(server => server ? askHost({
    hydraId,
    body: {
      action: 'hydra',
      id: String(result.message),
      text,
      actor: m.actor,
    },
  }).then(hosted => ({
    ...result,
    ...hosted,
    help: ['The Pnyx server runs Hydra; replies and startup errors appear in its chat'],
  })) : result)
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

  const events = readEvents({ hydraId }).filter(e => e.seq > after
    && (e.type === 'hydra.message' || e.type === 'task.reminder-due'))
  const page = events.slice(
    0,
    limit,
  )

  const through = page.at(-1)?.seq ?? after

  return {
    hydra: hydraConfig({
      state,
      id: hydraId,
    }).hydra.id,
    messages: page.length
      ? page.map(e => {
        if (e.type !== 'hydra.message' && e.type !== 'task.reminder-due') {
          throw new Error(`Unexpected ${e.type} in Hydra messages`)
        }

        const data = e.type === 'task.reminder-due' ? e.data.message : e.data

        return values.full ? e : {
          seq: e.seq,
          id: e.id,
          at: e.at,
          actor: e.type === 'task.reminder-due' ? HYDRA_ACTOR : e.actor,
          task: data.task ?? 'none',
          action: data.action,
          text: data.text,
          ...(data.details ? { details: data.details } : {}),
          ...('context' in data && data.context ? { context: data.context } : {}),
        }
      })
      : `none: no messages after seq ${after}`,
    through,
    ...(events.length > limit ? { help: [`Run \`pnyx-axi hydra messages --after ${through} --hydra ${hydraId}\` for the next page`] } : { help: [`Run \`pnyx-axi hydra messages --after ${through} --hydra ${hydraId}\` later for new messages`] }),
  }
}

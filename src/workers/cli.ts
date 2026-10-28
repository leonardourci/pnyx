import { OVERRIDE_FIELDS, overrideOf, type Override } from './dispatch.ts'
import { HydraError } from '../store/errors.ts'
import type { HydraEvent, HydraState } from '../app/model.ts'
import type { Output } from '../app/cli-support.ts'
import type { Meta } from '../app/command-meta.ts'
import { loadHydra } from '../app/store.ts'
import { sendReply } from './reply.ts'
import { taskPrompt } from './start.ts'
import { selfSession } from './session-attachments.ts'
import { readEvents } from '../app/event-log.ts'

export function startOverride({
  values,
}: {
  values: Record<string, unknown>
}): Override | undefined {
  const { fast } = values

  if (fast !== undefined && fast !== 'on' && fast !== 'off') {
    throw new HydraError({
      message: '--fast takes on or off',
      code: 'VALIDATION_ERROR',
    })
  }

  const named = OVERRIDE_FIELDS.filter(name => name !== 'fast' && values[name] !== undefined)
  const empty = named.find(name => !String(values[name]).trim())

  if (empty) {
    throw new HydraError({
      message: `--${empty} needs a value`,
      code: 'VALIDATION_ERROR',
    })
  }

  return overrideOf({
    value: Object.fromEntries([
      ...named.map(name => [
        name,
        values[name],
      ]),
      ...(fast === undefined ? [] : [
        [
          'fast',
          fast === 'on',
        ],
      ]),
    ]),
  })
}

type Attachment = Extract<HydraEvent, { type: 'task.session' }>

// Attachment is durable even when delivery fails.
export async function afterAttach({
  hydraId,
  result,
  attachment,
  meta,
}: {
  hydraId: string
  result: Output
  attachment: Attachment
  meta: Meta
}): Promise<Output> {
  if (!attachment.data.brief) {
    return result
  }

  const state = loadHydra({ hydraId }).state
  const home = state.config?.hydra.home

  try {
    const brief = await sendReply({
      hydraId,
      request: {
        card: attachment.cardId,
        text: taskPrompt({
          hydraId,
          card: state.cards[attachment.cardId]!,
        }),
        expectedSession: attachment.data.session,
        homes: home ? [home] : [],
        actor: meta.actor,
        id: `brief:${attachment.id}`,
      },
    })

    return {
      ...result,
      brief,
    }
  } catch (error) {
    return {
      ...result,
      brief: {
        state: 'failed',
        detail: error instanceof Error ? error.message : String(error),
      },
      help: ['The attachment was recorded; inspect the task before retrying its brief with the same --event-id'],
    }
  }
}

export function sessionRef({
  state,
  ref,
}: {
  state: HydraState
  ref: string
}): string {
  return ref === 'self'
    ? selfSession({
      state,
      here: {
        paseoTerminal: process.env.PASEO_TERMINAL_ID,
        tmuxPane: process.env.TMUX_PANE,
        herdrPane: process.env.HERDR_PANE_ID,
      },
    }).id
    : ref
}

export function taskSessions({
  hydraId,
  ids,
}: {
  hydraId: string
  ids: Set<string>
}): Set<string> {
  const sessions = new Set<string>()

  for (const event of readEvents({ hydraId })) {
    if (event.type === 'task.session' && (ids.has(event.data.before ?? '') || ids.has(event.data.after ?? ''))) {
      sessions.add(event.data.session)
    }

    if (ids.has(event.cardId) && event.type === 'card.pushed' && event.data.agent) {
      const agent = event.data.agent
      sessions.add(`${agent.provider}:${agent.sessionId}${agent.agentId ? `/${agent.agentId}` : ''}`)
    }
  }

  return sessions
}

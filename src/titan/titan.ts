import { reportActor } from '#app/actors.ts'
import type { TitanState, TitanChange, Decision } from '#app/model.ts'
import type { Meta } from '#app/command-meta.ts'
import { TitanError } from '#store/errors.ts'
import { EVENT_VERSION } from '#store/events.ts'
import type { TitanMessage } from './model.ts'
import { hydraConfig } from './config.ts'
import { TITAN_CARD } from './identity.ts'

export function hydraEvent({
  state,
  meta,
  cardId,
  change,
}: {
  state: TitanState
  meta: Meta
  cardId: string
  change: Pick<TitanChange, 'type' | 'data'>
}): Decision {
  if (meta.id && Object.hasOwn(
    state.eventIds,
    meta.id,
  )) {
    return { skipped: 'duplicate' }
  }

  const revision = cardId === '$projects' ? state.projectsRevision ?? 0 : cardId === '$board' ? state.configRevision ?? 0 : state.cards[cardId]?.revision ?? 0

  if (meta.ifRevision !== undefined && meta.ifRevision !== revision) {
    throw new TitanError({
      message: `revision ${revision}, not ${meta.ifRevision}`,
      code: 'REVISION_CONFLICT',
    })
  }

  let id = meta.id ?? `evt_${state.seq + 1}`

  for (let n = 2; !meta.id && id in state.eventIds; n++) {
    id = `evt_${state.seq + 1}_${n}`
  }

  const event = {
    v: EVENT_VERSION,
    seq: state.seq + 1,
    id,
    at: meta.at,
    actor: meta.actor,
    cardId,
    ...(meta.reason ? { reason: meta.reason } : {}),
    ...change,
  } as TitanChange

  if (meta.details) {
    event.details = meta.details
  }

  return { event }
}

// Titan ends a turn that needs nothing from the owner with only this reply, which its chat hides.
export const QUIET_REPLY = 'NO_REPLY'

export { agentActor, reportActor } from '#app/actors.ts'

// The exact text Titan receives, so its transcript copy of a report is known by identity, never by markup.
export function hydraDelivery({ message }: { message: Pick<TitanMessage, 'id' | 'actor' | 'task' | 'kind' | 'text' | 'details' | 'context'> }) {
  const said = [
    message.text,
    message.details,
    message.context,
  ].filter(Boolean).join('\n\n')

  if (!reportActor({ actor: message.actor })) {
    return said
  }

  // A report cannot close its own envelope, or what follows it would reach Titan outside it.
  const body = said.replace(
    /<\/othrys-report/gi,
    '<\\/othrys-report',
  )
  const quoted = ({ value }: { value: string }) => `"${value.replaceAll(
    '"',
    '&quot;',
  )}"`
  const task = message.task ? ` task=${quoted({ value: message.task })}` : ''
  const kind = message.kind ? ` kind=${quoted({ value: message.kind })}` : ''

  return `<othrys-report from=${quoted({ value: message.actor })}${task}${kind} message=${quoted({ value: message.id })}>\n${body}\n</othrys-report>`
}

export function hostedTitan({ state }: { state: TitanState }): boolean {
  return state.cards[TITAN_CARD]?.agent?.host === 'othrys'
}

export function othrysRunsTitan({ state }: { state: TitanState }): boolean {
  const agent = state.cards[TITAN_CARD]?.agent

  return !agent || agent.host === 'othrys'
}

// The mode a hosted Titan's session runs in, once it matches the composer's; none mid-switch.
export function hydraMode({ state }: { state: TitanState }): string | undefined {
  const running = state.cards[TITAN_CARD]?.settings?.mode
  const chosen = hydraConfig({ state }).hydra.agent
  const settled = !chosen || chosen.mode === running

  return hostedTitan({ state }) && settled ? running : undefined
}

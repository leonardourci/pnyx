import { inform } from '#app/command-notices.ts'
import { reportActor } from '#app/actors.ts'
import type { HydraState, HydraChange, Decision } from '#app/model.ts'
import type { Meta } from '#app/command-meta.ts'
import { informReportReviewGaps } from '#investigations/inventory.ts'
import { openAsks } from '#tasks/ask-state.ts'
import { HydraError } from '#store/errors.ts'
import { EVENT_VERSION } from '#store/events.ts'
import type { HydraMessage } from './model.ts'
import { hydraConfig } from './config.ts'
import { HYDRA_CARD } from './identity.ts'

export function hydraEvent({
  state,
  meta,
  cardId,
  change,
}: {
  state: HydraState
  meta: Meta
  cardId: string
  change: Pick<HydraChange, 'type' | 'data'>
}): Decision {
  if (meta.id && Object.hasOwn(
    state.eventIds,
    meta.id,
  )) {
    return { skipped: 'duplicate' }
  }

  if (change.type === 'task.visibility' && 'after' in change.data && change.data.after === true) {
    const card = state.cards[cardId]

    if (card) {
      informReportReviewGaps({
        state,
        card,
      })

      if (openAsks({ card }).some(ask => ask.origin)) {
        inform({
          task: card.id,
          reason: 'Task hidden with an open report question',
          clear: `Use pnyx-axi task show ${card.id} --full to inspect it`,
        })
      }
    }
  }

  const revision = cardId === '$projects' ? state.projectsRevision ?? 0 : cardId === '$board' ? state.configRevision ?? 0 : state.cards[cardId]?.revision ?? 0

  if (meta.ifRevision !== undefined && meta.ifRevision !== revision) {
    throw new HydraError({
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
  } as HydraChange

  if (meta.details) {
    event.details = meta.details
  }

  return { event }
}

// Hydra ends a turn that needs nothing from the owner with only this reply, which its chat hides.
export const QUIET_REPLY = 'NO_REPLY'

export { agentActor, reportActor } from '#app/actors.ts'

// The exact text Hydra receives, so its transcript copy of a report is known by identity, never by markup.
export function hydraDelivery({ message }: { message: Pick<HydraMessage, 'id' | 'actor' | 'task' | 'kind' | 'text' | 'details' | 'context'> }) {
  const said = [
    message.text,
    message.details,
    message.context,
  ].filter(Boolean).join('\n\n')

  if (!reportActor({ actor: message.actor })) {
    return said
  }

  // A report cannot close its own envelope, or what follows it would reach Hydra outside it.
  const body = said.replace(
    /<\/pnyx-report/gi,
    '<\\/pnyx-report',
  )
  const quoted = ({ value }: { value: string }) => `"${value.replaceAll(
    '"',
    '&quot;',
  )}"`
  const task = message.task ? ` task=${quoted({ value: message.task })}` : ''
  const kind = message.kind ? ` kind=${quoted({ value: message.kind })}` : ''

  return `<pnyx-report from=${quoted({ value: message.actor })}${task}${kind} message=${quoted({ value: message.id })}>\n${body}\n</pnyx-report>`
}

export function hostedHydra({ state }: { state: HydraState }): boolean {
  return state.cards[HYDRA_CARD]?.agent?.host === 'pnyx'
}

export function pnyxRunsHydra({ state }: { state: HydraState }): boolean {
  const agent = state.cards[HYDRA_CARD]?.agent

  return !agent || agent.host === 'pnyx'
}

// The mode a hosted Hydra's session runs in, once it matches the composer's; none mid-switch.
export function hydraMode({ state }: { state: HydraState }): string | undefined {
  const running = state.cards[HYDRA_CARD]?.settings?.mode
  const chosen = hydraConfig({ state }).hydra.agent
  const settled = !chosen || chosen.mode === running

  return hostedHydra({ state }) && settled ? running : undefined
}

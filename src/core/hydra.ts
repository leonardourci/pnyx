import { openAsks } from './asks.ts'
import { requireReportReview } from '../investigations/inventory.ts'
import { ownerGates } from './gates.ts'
import type { HydraState, HydraChange, Decision } from '../app/model.ts'
import { HydraError } from '../store/errors.ts'
import { EVENT_VERSION } from '../store/events.ts'
import { TASK_STATES, type Card, type HydraConfig, type HydraMessage, type Link, type TaskStatus, type TaskDeclaration } from './model.ts'
import type { Meta } from '../app/command-meta.ts'
import { DEFAULT_COLUMNS } from '../tasks/column-defaults.ts'

export const HYDRA_CARD = '$hydra'

// ponytail: a never-configured Hydra replays onto the defaults directly, so only its cards moved into Workers on it get placed by status; record a layout version if such logs ever matter.
export function hydraConfig({
  state,
  id = 'default',
}: {
  state: HydraState
  id?: string
}): HydraConfig {
  return state.config ?? {
    id,
    name: id,
    hydra: {
      id: 'hydra',
      kind: 'agent',
      name: 'Hydra',
    },
    columns: [
      ...structuredClone(DEFAULT_COLUMNS),
      ...(state.view?.customColumns ?? []),
    ],
  }
}

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
  if (meta.id && meta.id in state.eventIds) {
    return { skipped: 'duplicate' }
  }

  if (change.type === 'task.visibility' && 'after' in change.data && change.data.after === true) {
    const card = state.cards[cardId]

    if (card) {
      requireReportReview({
        state,
        card,
      })

      if (openAsks({ card }).some(ask => ask.origin)) {
        throw new HydraError({
          message: 'answer or evidence-close the report question before hiding its task',
          code: 'OWNER_DECISION_PENDING',
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

// A declared state as shown to people and Hydra: a paused wait names its end, a hold says it has none.
export function declaredState({ declaration }: { declaration: Pick<TaskDeclaration, 'state' | 'until' | 'hold'> }): string {
  if (declaration.until) {
    return `${declaration.state} until ${declaration.until}`
  }

  if (declaration.hold) {
    return `${declaration.state} on hold`
  }

  return declaration.state
}

export function declareTask({
  state,
  ref,
  status,
  note,
  meta,
  source,
  raw,
  until,
  waitingFor,
  restores,
  hold,
}: {
  state: HydraState
  ref: string
  status: string
  note: string
  meta: Meta
  source?: string
  raw?: string
  until?: string
  waitingFor?: string[]
  restores?: string
  hold?: boolean
}): Decision {
  const card = state.cards[ref] ?? state.cards[state.keys[ref] ?? '']

  if (!card || card.automaticTask || card.id === HYDRA_CARD) {
    throw new HydraError({
      message: `task not found: ${ref}`,
      code: 'NOT_FOUND',
    })
  }

  if (status === 'done') {
    requireReportReview({
      state,
      card,
    })
  }

  const normalized = status === 'needs-you' || status === 'needs you' ? 'needs_you' : status

  if (!(TASK_STATES as readonly string[]).includes(normalized)) {
    throw new HydraError({
      message: `use ${TASK_STATES.join(', ')}`,
      code: 'VALIDATION_ERROR',
    })
  }

  if (until !== undefined && normalized !== 'paused') {
    throw new HydraError({
      message: '--until goes only with paused',
      code: 'VALIDATION_ERROR',
    })
  }

  if (hold && normalized !== 'paused') {
    throw new HydraError({
      message: '--hold goes only with paused',
      code: 'VALIDATION_ERROR',
    })
  }

  if (hold && until !== undefined) {
    throw new HydraError({
      message: 'a hold has no end; use --hold or --until, not both',
      code: 'VALIDATION_ERROR',
    })
  }

  const data: Omit<TaskDeclaration, 'id' | 'at' | 'actor'> = {
    state: normalized as TaskStatus,
    note,
  }

  if (normalized === 'needs_you' || normalized === 'blocked') {
    const gates = waitingFor ?? ownerGates({ card })

    if (gates.length || waitingFor) {
      data.waitingFor = gates
    }
  }

  if (restores) {
    data.restores = restores
  }

  if (source) {
    data.source = source
  }

  if (raw) {
    data.raw = raw
  }

  if (until) {
    data.until = until
  }

  if (hold) {
    data.hold = true
  }

  return hydraEvent({
    state,
    meta,
    cardId: card.id,
    change: {
      type: 'task.declared',
      data,
    },
  })
}

// Hydra ends a turn that needs nothing from the owner with only this reply, which its chat hides.
export const QUIET_REPLY = 'NO_REPLY'

// Pnyx itself, a hook, a session or a worker: an agent's write, never the owner's or Hydra's.
export const agentActor = ({ actor }: { actor: string }) => /^(pnyx$|hook:|session:|worker:)/.test(actor)

// A worker's or session's message to Hydra is its report, never the owner's words.
export const reportActor = ({ actor }: { actor: string }) => actor !== 'pnyx' && agentActor({ actor })

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

// Hydra is a session the Pnyx server runs, not a Firstmate home or an outside agent.
export function hostedHydra({ state }: { state: HydraState }): boolean {
  return hydraConfig({ state }).hydra.kind !== 'firstmate' && state.cards[HYDRA_CARD]?.agent?.host === 'pnyx'
}

// Pnyx runs this Hydra's agent, or starts it on the next message: not a Firstmate home or an outside agent.
export function pnyxRunsHydra({ state }: { state: HydraState }): boolean {
  const agent = state.cards[HYDRA_CARD]?.agent
  const runsHere = !agent || agent.host === 'pnyx'

  return hydraConfig({ state }).hydra.kind !== 'firstmate' && runsHere
}

// The mode a hosted Hydra's session runs in, once it matches the composer's; none mid-switch.
export function hydraMode({ state }: { state: HydraState }): string | undefined {
  const running = state.cards[HYDRA_CARD]?.settings?.mode
  const chosen = hydraConfig({ state }).hydra.agent
  const settled = !chosen || chosen.mode === running

  return hostedHydra({ state }) && settled ? running : undefined
}

// Codex's never runs with the same full access as Bypass permissions.
export function hydraBypasses({ state }: { state: HydraState }): boolean {
  const mode = hydraMode({ state })
  const codexNever = mode === 'never' && state.cards[HYDRA_CARD]?.agent?.provider === 'codex'

  return mode === 'bypassPermissions' || codexNever
}

// Pnyx wakes a task's worker with news on its open pull request; a task whose worker ended, or that never had one, leaves it unwatched.
export function unwatchedPullRequests({ card }: { card: Card }): Link[] {
  if (card.sessionIds?.length && !card.stoppedAt) {
    return []
  }

  return card.links.filter(l => l.kind === 'github_pr' && l.state !== 'merged' && l.state !== 'closed')
}

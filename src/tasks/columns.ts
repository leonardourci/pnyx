import { ownerGates } from './owner-gates.ts'
import type { HydraState } from '#app/model.ts'
import { HydraError } from '#store/errors.ts'
import { CARD_FACTS, LEGACY_IN_PROGRESS, type CardFact, type ColumnCondition, type ColumnRule, type HydraColumn } from './columns-model.ts'
import type { Card } from './model.ts'
import { failedChecks, pendingChecks, ranChecks } from '#tasks/delivery/model.ts'
import { cardSessionId, assignDefined } from '#workers/session-attachments.ts'
import { hydraConfig } from '#hydra/config.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { permissionAttention } from '#workers/permission-rules.ts'
import { fallbackColumn } from './column-rules.ts'
import { columnRule } from './column-defaults.ts'

export function cardFacts({
  card,
  state,
}: {
  card: Card
  state: HydraState
}): CardFact[] {
  const facts: CardFact[] = []
  const prs = card.links.filter(link => link.kind === 'github_pr')
  const live = prs.filter(link => link.state !== 'closed')
  const allMerged = live.length > 0 && live.every(link => link.state === 'merged')
  const done = card.status?.state === 'done' || allMerged
  const open = prs.some(link => link.state === 'open')
  const session = state.sessions?.[cardSessionId({ card }) ?? '']
  const observedActivity = session?.sessionActivity ?? session?.activity
  const activity = observedActivity ?? card.sessionActivity ?? card.activity
  const status = card.status?.state
  let worker: CardFact = 'worker:none'

  if (activity === 'ended' || (!activity && card.stoppedAt)) {
    worker = 'worker:ended'
  } else if (status === 'paused') {
    worker = open && !card.status?.hold ? 'worker:checks' : 'worker:paused'
  } else if (status === 'blocked') {
    worker = 'worker:blocked'
  } else if ((card.asks ?? []).some(ask => ask.audience === 'hydra' && !ask.answered && !ask.closed)
    || status === 'needs_you') {
    worker = 'worker:hydra'
  } else if (status === 'working' || card.agent || card.sessionIds?.length) {
    worker = 'worker:working'
  }

  facts.push(
    worker,
    `kind:${card.kind ?? 'build'}`,
  )

  if (ownerGates({ card }).length) {
    facts.push('owner-question')
  }

  if (card.reminder?.dueAt) {
    facts.push('reminder-due')
  }

  if (card.hold) {
    facts.push('held')
  }

  if (card.queue) {
    facts.push('queued')
  }

  if (done) {
    facts.push('done')
  }

  if (!prs.length) {
    facts.push('pr:none')
  }

  for (const link of prs) {
    if (link.state === 'merged') {
      facts.push('pr:merged')
      continue
    }

    if (link.state === 'closed') {
      facts.push('pr:closed')
      continue
    }

    if (link.draft) {
      facts.push('pr:draft')
    }

    if (link.state !== 'open') {
      continue
    }

    facts.push('pr:open')

    if (pendingChecks({ checks: link.checks }) > 0) {
      facts.push('pr:pending')
    }

    if (failedChecks({ checks: link.checks }) > 0) {
      facts.push('pr:red')
    } else if (ranChecks({ checks: link.checks }) && !pendingChecks({ checks: link.checks })) {
      facts.push('pr:green')
    }
  }

  return [...new Set(facts)]
}

export function placeCard({
  card,
  columns,
}: {
  card: CardFact[]
  columns: HydraColumn[]
}) {
  const facts = new Set<string>(card)

  return columns.find(column => columnRule({ column }).some(conditions =>
    conditions.every(condition => condition.startsWith('!')
      ? !facts.has(condition.slice(1)) : facts.has(condition))))?.id
}

function parseCondition({ condition }: { condition: string }): ColumnCondition {
  const fact = condition.startsWith('!') ? condition.slice(1) : condition
  const known = CARD_FACTS.find(candidate => candidate === fact)

  if (!known) {
    throw new HydraError({
      message: `unknown column fact: ${condition || '(empty)'}`,
      code: 'VALIDATION_ERROR',
      help: [`Use ${CARD_FACTS.join(', ')}; prefix a fact with ! to negate it`],
    })
  }

  return condition.startsWith('!') ? `!${known}` : known
}

export function parseColumnRule({ when }: { when: string[] }): ColumnRule {
  return when.map(row => row.split(',').map(part => parseCondition({ condition: part.trim() })))
}

export function validateColumnRule({ rule }: { rule: unknown }): void {
  if (!Array.isArray(rule) || rule.some(row => !Array.isArray(row) || !row.length
    || row.some(condition => typeof condition !== 'string'))) {
    throw new HydraError({
      message: 'a column rule is a list of nonempty condition lists (or [] for manual placement)',
      code: 'VALIDATION_ERROR',
    })
  }

  for (const row of rule) {
    for (const condition of row) {
      parseCondition({ condition })
    }
  }
}

export function describeColumnRule({ column }: { column: HydraColumn }): string {
  const rule = columnRule({ column })

  return rule.length ? rule.map(row => row.join(' AND ')).join(' OR ') : 'manual only'
}

export function refreshTasks({
  state,
  ids,
}: {
  state: HydraState
  ids?: (string | null | undefined)[]
}): void {
  const columns = hydraConfig({ state }).columns
  const cards = ids
    ? [...new Set(ids)].flatMap(id => (id && state.cards[id] ? [state.cards[id]] : []))
    : Object.values(state.cards)

  for (const card of cards) {
    permissionAttention({ card })

    if (card.automaticTask || card.sourceRefs.some(r => r.adapter === 'firstmate' && r.objectId === '@home')) {
      card.hidden = true
    }

    if (card.sourceRefs.some(r => r.adapter === 'firstmate' && r.objectId !== '@home')
      || (state.configured && !card.hidden && card.id !== HYDRA_CARD)) {
      card.tracking = 'declared'
    }

    // Legacy Firstmate home cards were grouping parents, not work.
    if ((state.configured || card.tracking) && card.parentId && state.cards[card.parentId]?.sourceRefs.some(r => r.adapter === 'firstmate' && r.objectId === '@home')) {
      delete card.parentId
    }

    // Workers on it keeps its cards until the Hydra moves onto the default columns, which places them by status.
    if (!columns.some(c => c.id === card.column) && card.column !== LEGACY_IN_PROGRESS) {
      card.column = fallbackColumn({ columns })
    }
  }

  const hydra = state.cards[HYDRA_CARD]
  const ref = state.config?.hydra.session
  const session = ref ? state.sessions?.[ref] : undefined

  if (hydra) {
    if (session && hydra.launch?.via === 'command' && session.launch?.via === 'hooks') {
      session.launch = {
        ...hydra.launch,
        harness: session.agent.provider,
      }
    }

    hydra.sessionIds = session ? [session.id] : []
    assignDefined({
      target: hydra,
      values: {
        agent: session && { ...session.agent },
        terminal: session?.terminal && { ...session.terminal },
        ...(session?.agent.host === 'pnyx' ? {
          settings: session.settings && { ...session.settings },
          activity: session.activity,
          sessionActivity: session.sessionActivity ?? session.activity,
          workingSince: session.workingSince,
        } : {}),
      },
    })
    hydra.attention = session?.agent.host === 'pnyx'
      ? [
        ...hydra.attention.filter(a => !a.key.startsWith('hook:')),
        ...session.attention,
      ]
      : session ? [...session.attention] : []
    hydra.hidden = true
  }
}

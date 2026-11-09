import type { HydraEvent, HydraState } from '#app/model.ts'
import type { Card } from '#tasks/model.ts'
import { cardLanding, type Link } from './model.ts'
import { hydraEvent, reportActor } from '#hydra/hydra.ts'
import { isManagedTask } from '#tasks/select.ts'
import { openAsks } from '#tasks/ask-state.ts'

export function mergeApproval({
  state,
  card,
  url,
}: {
  state?: HydraState
  card: Card
  url: string
}) {
  const question = canonicalMergeQuestion({
    state,
    card,
    url,
  })?.ask

  return question?.answered && !question.closed && question.choice === 'Merge' ? question : undefined
}

export function canonicalMergeQuestion({
  state,
  card,
  url,
}: {
  state?: HydraState
  card: Card
  url: string
}) {
  const cards = state ? Object.values(state.cards) : [card]
  const questions = cards.flatMap(card => (card.asks ?? [])
    .filter(ask => ask.kind === 'merge' && ask.url === url)
    .map(ask => {
      const decisionAt = Math.max(
        Date.parse(ask.at),
        Date.parse(ask.answeredAt ?? ask.at),
        Date.parse(ask.reaskedAt ?? ask.at),
      )

      return {
        card,
        ask,
        decisionAt,
        activeAt: Math.max(
          decisionAt,
          Date.parse(ask.closed?.at ?? ask.at),
        ),
      }
    }))
  const latest = questions.toSorted((
    a,
    b,
  ) => b.decisionAt - a.decisionAt || a.ask.id.localeCompare(b.ask.id))[0]

  // Retiring an older alias must not hide a newer pending decision.
  if (latest && !latest.ask.answered && !latest.ask.closed) {
    return latest
  }

  return questions.sort((
    a,
    b,
  ) => b.activeAt - a.activeAt || a.ask.id.localeCompare(b.ask.id))[0]
}

export function reconcileAsks({
  state,
  event,
}: {
  state: HydraState
  event: HydraEvent
}): HydraEvent[] {
  const card = state.cards[event.cardId]

  if (!card || isManagedTask({ card }) || state.config?.hydra.kind === 'firstmate'
    || event.type === 'task.ask.closed') {
    return []
  }

  const changes: HydraEvent[] = []
  const declaredDone = event.type === 'task.declared' && event.data.state === 'done'
    && card.kind !== 'investigation' && card.status?.actor !== 'pnyx'
  const cancelled = event.type === 'card.outcome' && event.data.after?.closed === true
  const movedDone = event.type === 'card.moved' && event.actor !== 'pnyx'
    && card.kind !== 'investigation' && event.data.before !== event.data.after && state.config?.columns
    .some(column => column.id === card.column && column.role === 'done')
  const ended = declaredDone || cancelled || movedDone

  for (const ask of openAsks({
    card,
    audience: 'owner',
  })) {
    if (ask.origin || (ask.kind === 'go' && ask.hold?.id === card.hold?.id)) {
      continue
    }

    const link = card.links.find(link => link.url === ask.url)
    const settled = link?.state === 'merged' || link?.state === 'closed'
    const moot = ask.kind === 'merge' && settled

    const released = ask.kind === 'go' && ask.hold?.id !== card.hold?.id

    if (!ended && !moot && !released) {
      continue
    }

    const reason = released ? 'Discussion hold released or replaced' : ended ? 'Task ended' : 'Pull request merged or closed'
    const closed = hydraEvent({
      state,
      cardId: card.id,
      meta: {
        id: `${event.id}:${ask.id}:closed`,
        at: event.at,
        actor: 'pnyx',
        reason,
      },
      change: {
        type: 'task.ask.closed',
        data: {
          ask: ask.id,
          reason,
          evidence: link?.url ?? event.id,
        },
      },
    })

    if ('event' in closed) {
      changes.push(closed.event)
    }
  }

  if (event.type !== 'card.linked' || card.status?.state === 'done' || card.outcome?.closed) {
    return changes
  }

  const link = event.data.after
  const ownerMerges = cardLanding({
    card,
    projects: state.projects ?? [],
  })?.merge === 'owner'
  const ready = link?.kind === 'github_pr' && link.state === 'open' && link.draft === false
  const existing = link && canonicalMergeQuestion({
    state,
    card,
    url: link.url,
  })
  const alreadyAsked = existing && !existing.ask.closed

  if (!ready || !ownerMerges || alreadyAsked) {
    return changes
  }

  const asked = hydraEvent({
    state,
    cardId: card.id,
    meta: {
      id: `${event.id}:merge-question`,
      at: event.at,
      actor: 'pnyx',
    },
    change: {
      type: 'task.asked',
      data: mergeQuestion({
        state,
        card,
        link,
        id: `ask-${state.seq + 1}`,
      }),
    },
  })

  if ('event' in asked) {
    changes.push(asked.event)
  }

  return changes
}

function mergeQuestion({
  state,
  card,
  link,
  id,
}: {
  state: HydraState
  card: Card
  link: Link
  id: string
}): Extract<HydraEvent, { type: 'task.asked' }>['data'] {
  const number = link.url.split('/').at(-1)
  const report = state.hydraMessages?.findLast(message => message.task === card.id
    && reportActor({ actor: message.actor }) && !message.ask)
  let note = card.statusLog?.findLast(status => reportActor({ actor: status.actor }))

  if (!note && card.status && reportActor({ actor: card.status.actor })) {
    note = card.status
  }

  let workerText = note?.note
  let workerLabel = 'Worker status note'

  if (report && (!note || Date.parse(report.at) >= Date.parse(note.at))) {
    workerText = report.text
    workerLabel = 'Worker report'
  }

  const context = [
    ownerContext({ text: link.title ?? card.title }),
    link.url,
  ]

  if (workerText?.trim()) {
    context.push(`${workerLabel}: ${ownerContext({ text: workerText })}`)
  }

  context.push(`Checks: ${link.checks ?? 'not read yet'}`)

  return {
    id,
    audience: 'owner',
    kind: 'merge',
    url: link.url,
    question: `Review and merge PR #${number}?`,
    context: context.join('\n'),
    options: [
      { label: 'Merge' },
      { label: 'Hold' },
    ],
  }
}

function ownerContext({ text }: { text: string }): string {
  return text.replace(
    /\b(?:(?:task-|worker:|session:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|ask-\d+|evt_\d+(?:_\d+)?)\b/gi,
    '[internal reference]',
  )
}

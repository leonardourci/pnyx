import type { HydraEvent, HydraState } from '#app/model.ts'
import type { Card } from '#tasks/model.ts'
import { cardLanding, type Link } from './model.ts'
import { hydraEvent, reportActor } from '#hydra/hydra.ts'
import { isManagedTask } from '#tasks/select.ts'
import { openAsks } from '#tasks/ask-state.ts'

export const mergeApproval = ({
  card,
  url,
}: {
  card: Card
  url: string
}) =>
  card.asks?.find(ask => ask.kind === 'merge' && ask.url === url && ask.answered && !ask.closed && ask.choice === 'Merge')

export function reconcileAsks({
  state,
  event,
}: {
  state: HydraState
  event: HydraEvent
}): HydraEvent[] {
  const card = state.cards[event.cardId]

  if (!card || isManagedTask({ card }) || state.config?.hydra.kind === 'firstmate') {
    return []
  }

  const changes: HydraEvent[] = []
  const ended = card.status?.state === 'done' || !!card.outcome?.closed
  const requests = card.links.filter(link => link.kind === 'github_pr')
  const allSettled = requests.length > 0
    && requests.every(link => link.state === 'merged' || link.state === 'closed')

  for (const ask of openAsks({
    card,
    audience: 'owner',
  })) {
    if (ask.origin || (ask.kind === 'go' && ask.hold?.id === card.hold?.id)) {
      continue
    }

    const link = card.links.find(link => link.url === ask.url)
    const settled = link?.state === 'merged' || link?.state === 'closed'
    const moot = ask.url ? settled : allSettled

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
      return [closed.event]
    }
  }

  if (event.type !== 'card.linked' || ended) {
    return changes
  }

  const link = event.data.after
  const ownerMerges = cardLanding({
    card,
    projects: state.projects ?? [],
  })?.merge === 'owner'
  const ready = link?.kind === 'github_pr' && link.state === 'open' && link.draft === false
  const alreadyAsked = card.asks?.some(ask => ask.kind === 'merge' && ask.url === link?.url)

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

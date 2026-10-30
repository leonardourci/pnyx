import type { HydraState } from '#app/model.ts'
import type { Card } from '#tasks/model.ts'
import type { CurrentAction } from '#hydra/calls.ts'
import { cardStatus, type CardStatus } from '#tasks/card-status.ts'
import { openAsks } from '#tasks/questions.ts'
import { unmetPrerequisites } from '#tasks/dependencies.ts'
import { failedChecks, pendingChecks } from '#tasks/delivery/model.ts'
import { nativeIdle } from '#workers/native-work.ts'

export interface ObservedStatus extends CardStatus {
  details: string
}

// Declarations remain the worker's words; only observed facts choose the badge.
export function observedStatus({
  card,
  state,
  action,
  connected = true,
}: {
  card: Card
  state?: HydraState
  action?: CurrentAction
  connected?: boolean
}): ObservedStatus {
  const base = cardStatus({
    card: {
      ...card,
      status: undefined,
    },
  })
  const reasons: CardStatus[] = []
  const unknownChecks: CardStatus[] = []
  const add = ({
    kind,
    text,
    at,
  }: CardStatus) => reasons.push({
    kind,
    text,
    at,
  })
  const requests = card.links.filter(link => link.kind === 'github_pr' && link.state === 'open').toSorted((
    a,
    b,
  ) => failedChecks({ checks: b.checks }) - failedChecks({ checks: a.checks }))
  const work = connected ? action?.work : undefined
  const nativeRunning = work && (work.runningTurns.length > 0 || work.runningTools.length > 0
    || work.unsettledInputs.length > 0 || work.pendingControls.length > 0
    || (work.queue.knowledge === 'known' && work.queue.count > 0))

  if ([
    'done',
    'asks',
    'answering',
    'paused',
    'stopped',
  ].includes(base.kind)) {
    let text = base.text

    if (text === 'needs you') {
      text = 'waiting for you'
    }

    if (card.hold && base.kind === 'paused') {
      text = 'on hold'
    }

    reasons.push({
      ...base,
      text,
    })
  }

  if (work?.runningTools.length || (connected && !work && base.kind === 'working' && action && !action.done && action.calls.length)) {
    const names = [...new Set(action?.calls.map(call => call.tool) ?? [])]
    add({
      kind: 'working',
      text: `running ${names.join(', ') || 'tool'}`,
    })
  }

  if (work?.background.knowledge === 'known' && work.background.tasks.length) {
    add({
      kind: 'working',
      text: 'running background work',
    })
  }

  if (!reasons.some(reason => reason.kind === 'working') && (nativeRunning || (connected && base.kind === 'working'))) {
    add({
      kind: 'working',
      text: 'working',
    })
  }

  if (openAsks({
    card,
    audience: 'hydra',
  }).length) {
    add({
      kind: 'asks-hydra',
      text: 'waiting for Hydra',
    })
  }

  for (const link of requests) {
    if (failedChecks({ checks: link.checks })) {
      add({
        kind: 'blocked',
        text: 'checks failed',
        at: link.checkedAt,
      })
    } else if (pendingChecks({ checks: link.checks })) {
      add({
        kind: 'waiting',
        text: 'waiting for CI',
        at: link.checkedAt,
      })
    } else if (!link.checkedAt || !link.checks) {
      unknownChecks.push({
        kind: 'unknown',
        text: 'checks unknown',
        at: link.checkedAt,
      })
    }
  }

  if (state) {
    for (const prerequisite of unmetPrerequisites({
      state,
      card,
    })) {
      add({
        kind: 'waiting',
        text: `waiting for ${prerequisite.title}`,
      })
    }
  }

  if (card.queue) {
    add({
      kind: 'queued',
      text: 'queued',
    })
  }

  if (!reasons.length && unknownChecks.length) {
    reasons.push(...unknownChecks)
  }

  if (!reasons.length) {
    if (work && base.kind === 'finished' && nativeIdle({ work })) {
      add({
        kind: 'finished',
        text: 'idle',
      })
    } else if (card.agent) {
      add({
        kind: 'unknown',
        text: 'activity unknown',
      })
    } else {
      add({
        kind: 'not-started',
        text: 'no worker assigned',
      })
    }
  }

  const status = reasons[0]!
  const details = [
    ...reasons,
    ...unknownChecks.filter(reason => !reasons.includes(reason)),
  ].map(reason => reason.at ? `${reason.text} (observed ${reason.at})` : reason.text)

  return {
    ...status,
    details: details.join('\n'),
  }
}

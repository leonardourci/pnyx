import { taskReadiness } from '#tasks/dependencies.ts'
import { askWording, openAsks } from '#tasks/ask-state.ts'
import { openDecisions } from '#tasks/decisions.ts'
import { HYDRA_CARD } from './identity.ts'
import type { HydraState } from '#app/model.ts'
import type { Card } from '#tasks/model.ts'
import { failedChecks, pendingChecks, ranChecks } from '#tasks/delivery/model.ts'
import { liveTask, taskDone } from '#tasks/select.ts'
import { cardSessionId } from '#workers/session-attachments.ts'
import { readyBacklog } from './wake-reasons.ts'
import { taskMention, taskMentions } from './mentions.ts'
import { questionReminder } from '#tasks/question-reminders.ts'
import { cardStatus, currentState } from '#tasks/card-status.ts'
import { BUSY_MS } from '#workers/host.ts'

export const MINUTE_MS = 60_000

const LEFT_OFF_STALE_DAYS = 7
const LEFT_OFF_STALE_MS = LEFT_OFF_STALE_DAYS * 24 * 60 * MINUTE_MS

interface ReviewFlag {
  kind: 'green unmerged PR' | 'quiet worker' | 'external blocker' | 'question reminder' | 'no live worker' | 'unwatched PR' | 'memory behind' | 'stale left-off' | 'prerequisite unmet'
  task: string
  detail: string
  reminder?: string
}

const mention = ({ card }: { card: Pick<Card, 'id' | 'title'> }) => taskMention({
  id: card.id,
  title: card.title,
})

const workerAttached = ({ card }: { card: Card }) =>
  Boolean(card.agent || card.sessionIds?.length)

function liveWorker({
  state,
  card,
}: {
  state: HydraState
  card: Card
}): boolean {
  if (!workerAttached({ card })) {
    return false
  }

  const session = card.sessionIds?.[0]
  const observed = state.sessions?.[session ?? '']
  const observedActivity = observed?.sessionActivity ?? observed?.activity
  const activity = card.sessionActivity ?? observedActivity ?? card.activity

  return activity !== 'ended' && !card.stoppedAt
}

const elapsed = ({
  at,
  now,
}: {
  at?: string
  now: number
}): string => {
  if (!at) {
    return 'age unknown'
  }

  const minutes = Math.max(
    0,
    Math.floor((now - Date.parse(at)) / MINUTE_MS),
  )

  return `${minutes} min old`
}

export function boardReview({
  state,
  now,
  workerSeenAt = {},
  memory = [],
}: {
  state: HydraState
  now: number
  workerSeenAt?: Record<string, number>
  memory?: string[]
}) {
  const decisions = openDecisions({ state })
  const ready = readyBacklog({ state })
  const tasks = Object.values(state.cards)
    .filter(card => card.id !== HYDRA_CARD && liveTask({ card }))
  const openPr = ({ card }: { card: Card }) =>
    card.links.some(link => link.kind === 'github_pr' && link.state === 'open')
  const active = ({ card }: { card: Card }) => workerAttached({ card }) || openPr({ card })
  const live = tasks.filter(card => active({ card })
    || decisions.some(item => item.card.id === card.id) || ready.some(item => item.id === card.id)
    || taskReadiness({
      state,
      card,
    }).unmet.length > 0)
  const flags: ReviewFlag[] = []
  const lines = [
    'Timed review:',
    ...memory,
  ]

  for (const card of live) {
    const ref = mention({ card })
    const watching = liveWorker({
      state,
      card,
    })
    const session = cardSessionId({ card }) ?? ''
    const recorded = state.sessions?.[session]?.lastSeen
    const observed = workerSeenAt[session] ?? 0
    const latest = currentState({
      card,
      workerOnly: true,
    })
    const workerTimes = [
      recorded,
      latest?.at,
      card.workingSince,
    ]
      .flatMap(at => at ? [Date.parse(at)] : [])
      .filter(Number.isFinite)

    if (observed > 0) {
      workerTimes.push(observed)
    }

    const seen = workerTimes.length ? Math.max(...workerTimes) : Date.parse(card.updatedAt)
    const quietAt = new Date(seen).toISOString()
    const activity = card.sessionActivity ?? card.activity ?? 'unknown'
    const status = cardStatus({
      card,
      cards: state.cards,
      sessions: state.sessions,
    })

    if (status.kind === 'working' && now - seen >= BUSY_MS) {
      flags.push({
        kind: 'quiet worker',
        task: card.id,
        detail: `Running with no update since ${quietAt}`,
      })
    }

    lines.push(`- ${ref} status: ${status.text}; worker: ${watching ? activity : 'none live'}, quiet ${elapsed({
      at: quietAt,
      now,
    })}`)

    const readiness = taskReadiness({
      state,
      card,
    })

    for (const item of readiness.unmet) {
      const detail = `waiting for ${item.title} (${item.id}): ${item.reason}`
      lines.push(`  Prerequisite: ${detail}`)

      if (workerAttached({ card }) && card.workerLog?.status?.code !== 'done') {
        flags.push({
          kind: 'prerequisite unmet',
          task: card.id,
          detail: `${detail}; worker already assigned, Hydra must review`,
        })
      }
    }

    for (const link of card.links.filter(link => link.kind === 'github_pr')) {
      lines.push(`  PR: ${link.url} ${link.state ?? 'unknown'}${link.draft ? ' draft' : ''}; checks: ${link.checks ?? 'unknown'} (${elapsed({
        at: link.checkedAt,
        now,
      })})`)

      if (link.state !== 'open') {
        continue
      }

      if (!watching) {
        flags.push({
          kind: 'unwatched PR',
          task: card.id,
          detail: `${link.url} has no live worker watching`,
        })
      }

      const checks = link.checks
      const finished = ranChecks({ checks }) && !pendingChecks({ checks })
      const green = !link.draft && finished && !failedChecks({ checks })

      if (green) {
        flags.push({
          kind: 'green unmerged PR',
          task: card.id,
          detail: link.url,
        })
      }

      const note = card.workerLog?.latest.text ?? ''
      const infrastructure = /\b(cancelled run|canceled run|base (?:is )?out[ -]of[ -]date)\b/i.test(note)
      const suite = /\bfull[ -]suite\b/i.test(note)
      const unrelated = /\b(unrelated|pre[ -]existing|outside (?:this|the) task)\b/i.test(note)
      const reportedOutside = card.workerLog?.status?.code === 'blocked' && (infrastructure || (suite && unrelated))

      if (reportedOutside) {
        flags.push({
          kind: 'external blocker',
          task: card.id,
          detail: `${link.url}: worker reports ${note}; put the decision to the owner`,
        })
      }
    }
  }

  const questionCards = [...live]
  const hydra = state.cards[HYDRA_CARD]

  if (hydra) {
    questionCards.push(hydra)
  }

  for (const card of questionCards) {
    for (const ask of openAsks({ card })) {
      const at = ask.reaskedAt ?? ask.escalated?.at ?? ask.at
      const wording = askWording({ ask }).question
      lines.push(`- ${mention({ card })} Question ${ask.id} to ${ask.audience}: ${wording} (${elapsed({
        at,
        now,
      })})`)
      const reminder = questionReminder({
        state,
        card,
        ask,
        now,
        forReview: true,
      })

      if (reminder) {
        flags.push({
          kind: 'question reminder',
          task: card.id,
          detail: reminder.detail,
          reminder: reminder.key,
        })
      }
    }
  }

  const cursorText = state.hydraMemory?.['check-cursor']?.text
  const cursor = Number(cursorText)

  if (cursorText && Number.isSafeInteger(cursor) && cursor >= 0 && cursor < state.seq) {
    flags.push({
      kind: 'memory behind',
      task: HYDRA_CARD,
      detail: `Hydra memory cursor ${cursor} is behind log ${state.seq}; reconcile it after handling changes`,
    })
  }

  const leftOff = state.hydraMemory?.['left-off']

  if (leftOff) {
    // A missing id is a typo or another Hydra's task, so it never counts as finished.
    const finished = ({ id }: { id: string }) => {
      const card = state.cards[id]

      if (!card) {
        return false
      }

      return !liveTask({ card }) || taskDone({
        state,
        card,
      })
    }

    const named = taskMentions({ text: leftOff.text })
    const allDone = named.length > 0 && named.every(finished)
    const old = now - Date.parse(leftOff.at) >= LEFT_OFF_STALE_MS

    if (allDone || old) {
      flags.push({
        kind: 'stale left-off',
        task: HYDRA_CARD,
        detail: allDone
          ? 'every task linked in Hydra memory `left-off` is done; rewrite or forget it'
          : `Hydra memory \`left-off\` is over ${LEFT_OFF_STALE_DAYS} days old; rewrite or forget it`,
      })
    }
  }

  lines.push('Ready in Backlog (free worker slots: no configured limit):')

  if (!ready.length) {
    lines.push('- none')
  }

  lines.push(...ready.map(card => `- ${mention({ card })}`))
  const flagHeading = flags.length ? `Review flags (${flags.length}):` : 'Review flags: none'
  lines.push(flagHeading)
  lines.push(...flags.map(flag => {
    const card = state.cards[flag.task]
    const ref = card ? mention({ card }) : 'Hydra'

    return `- ${ref} ${flag.kind}: ${flag.detail}`
  }))

  return {
    live: memory.length > 0 || tasks.some(card => active({ card }))
      || decisions.length > 0 || ready.length > 0 || live.some(card => taskReadiness({
      state,
      card,
    }).unmet.length > 0),
    block: lines.join('\n'),
    flags,
    reminders: flags.flatMap(flag => flag.reminder ? [flag.reminder] : []),
  }
}

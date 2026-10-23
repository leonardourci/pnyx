import { askWording, openAsks } from '../core/asks.ts'
import { openDecisions } from '../core/decisions.ts'
import { HYDRA_CARD, hydraConfig, roleColumn } from '../core/hydra.ts'
import { failedChecks, pendingChecks, ranChecks, type Card, type HydraState } from '../core/model.ts'
import { cardSessionId, liveTask } from '../core/tasks.ts'
import { mergeApproved, readyBacklog } from '../core/wake-reasons.ts'
import { taskMention } from '../mentions/mentions.ts'

export const MINUTE_MS = 60_000
export const QUESTION_REMINDER_MS = 4 * 60 * MINUTE_MS

export interface ReviewFlag {
  kind: 'approved merge is green' | 'external blocker' | 'question reminder' | 'no live worker' | 'unwatched PR' | 'memory behind'
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
}: {
  state: HydraState
  now: number
  workerSeenAt?: Record<string, number>
}) {
  const decisions = openDecisions({ state })
  const ready = readyBacklog({ state })
  const columns = hydraConfig({ state }).columns
  const progress = roleColumn({
    columns,
    role: 'in_progress',
  })
  const tasks = Object.values(state.cards)
    .filter(card => card.id !== HYDRA_CARD && liveTask({ card }))
  const openPr = ({ card }: { card: Card }) =>
    card.links.some(link => link.kind === 'github_pr' && link.state === 'open')
  const active = ({ card }: { card: Card }) => workerAttached({ card }) || openPr({ card })
  const live = tasks.filter(card => active({ card })
    || decisions.some(item => item.card.id === card.id) || ready.some(item => item.id === card.id)
    || card.column === progress)
  const flags: ReviewFlag[] = []
  const lines = ['Timed review:']

  for (const card of live) {
    const ref = mention({ card })
    const watching = liveWorker({
      state,
      card,
    })
    const column = columns.find(column => column.id === card.column)?.title ?? card.column
    const declaration = card.status
    const session = cardSessionId({ card }) ?? ''
    const recorded = state.sessions?.[session]?.lastSeen ?? card.updatedAt
    const observed = workerSeenAt[session] ?? 0
    const seen = observed > 0 ? observed : Date.parse(recorded)
    const quietAt = new Date(seen).toISOString()
    const activity = card.sessionActivity ?? card.activity ?? 'unknown'
    lines.push(`- ${ref} column: ${column}; declaration: ${declaration?.state ?? 'none'} (${elapsed({
      at: declaration?.at,
      now,
    })})${declaration?.note ? `: ${declaration.note}` : ''}; worker: ${watching ? activity : 'none live'}, quiet ${elapsed({
      at: quietAt,
      now,
    })}`)

    if (card.column === progress && !watching) {
      flags.push({
        kind: 'no live worker',
        task: card.id,
        detail: 'In progress with no live worker',
      })
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

      if (green && mergeApproved({
        state,
        card,
      })) {
        flags.push({
          kind: 'approved merge is green',
          task: card.id,
          detail: link.url,
        })
      }

      const note = declaration?.note ?? ''
      const infrastructure = /\b(cancelled run|canceled run|base (?:is )?out[ -]of[ -]date)\b/i.test(note)
      const suite = /\bfull[ -]suite\b/i.test(note)
      const unrelated = /\b(unrelated|pre[ -]existing|outside (?:this|the) task)\b/i.test(note)
      const reportedOutside = declaration?.state === 'blocked' && (infrastructure || (suite && unrelated))

      if (reportedOutside) {
        flags.push({
          kind: 'external blocker',
          task: card.id,
          detail: `${link.url}: worker reports ${declaration.note}; put the decision to the owner`,
        })
      }
    }

    for (const ask of openAsks({ card })) {
      const at = ask.escalated?.at ?? ask.at
      const wording = askWording({ ask }).question
      lines.push(`  Question ${ask.id} to ${ask.audience}: ${wording} (${elapsed({
        at,
        now,
      })})`)
      const reminder = `${card.id}:${ask.id}`
      const last = state.hydraReview?.reminders[reminder]
      const reminded = last && now - Date.parse(last) < QUESTION_REMINDER_MS
      const dueAt = card.reminder?.dueAt
      const scheduled = dueAt && now - Date.parse(dueAt) < QUESTION_REMINDER_MS

      const oldQuestion = now - Date.parse(at) > QUESTION_REMINDER_MS

      if (ask.audience === 'owner' && oldQuestion && !reminded && !scheduled) {
        flags.push({
          kind: 'question reminder',
          task: card.id,
          detail: `${ask.id}: ${wording}`,
          reminder,
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
    live: tasks.some(card => active({ card }))
      || decisions.length > 0 || ready.length > 0,
    block: lines.join('\n'),
    flags,
    reminders: flags.flatMap(flag => flag.reminder ? [flag.reminder] : []),
  }
}

import { ownerGates } from './owner-gates.ts'
import { openAsks } from './ask-state.ts'
import type { TitanState } from '#app/model.ts'
import type { Card } from './model.ts'
import type { DoneAfterHours } from '#settings/model.ts'
import { isManagedTask } from './select.ts'
import { cardStatus } from './card-status.ts'

export const DEFAULT_DONE_HOURS = 1
export const MAX_DONE_HOURS = 876000
export const HOUR_MS = 60 * 60 * 1000

// `task hide-after` hours: 0 to MAX_DONE_HOURS, null for `default` (the shared setting), undefined for a value it refuses.
export function hideAfterHours({ value }: { value: string }): number | null | undefined {
  const raw = value.trim()

  if (raw === 'default') {
    return null
  }

  const hours = Number(raw)

  return raw && Number.isFinite(hours) && hours >= 0 && hours <= MAX_DONE_HOURS ? hours : undefined
}

export function refreshDone({
  state,
  at,
}: {
  state: TitanState
  at: string
}): void {
  const children = new Map<string, Card[]>()

  for (const card of Object.values(state.cards)) {
    if (!card.parentId) {
      continue
    }

    const parts = children.get(card.parentId) ?? []
    parts.push(card)
    children.set(
      card.parentId,
      parts,
    )
  }

  for (const card of Object.values(state.cards)) {
    if (children.has(card.id)) {
      continue
    }

    const status = cardStatus({
      card: {
        ...card,
        doneAt: card.workerLog?.status?.code === 'done' ? card.doneAt : undefined,
      },
      cards: state.cards,
      sessions: state.sessions,
    }).kind
    const done = status === 'done' || status === 'merged'

    if (done && !isManagedTask({ card })) {
      card.doneAt ??= at
    } else {
      delete card.doneAt
      delete card.keepDone

      if (card.expired) {
        delete card.hidden
        delete card.expired
      }
    }
  }

  for (const [
    id,
    parts,
  ] of children) {
    const parent = state.cards[id]

    if (!parent || isManagedTask({ card: parent })) {
      continue
    }

    const working = (parent.sessionActivity ?? parent.activity) === 'working'
    const openPR = parent.links.some(link => link.kind === 'github_pr' && link.state === 'open')
    const partsDone = parts.every(part => part.doneAt)
    const ownerWaiting = ownerGates({ card: parent }).length > 0
    const complete = partsDone && !working && !openPR && !ownerWaiting

    if (complete) {
      const completed = parts.flatMap(part => part.doneAt ? [part.doneAt] : [])
      completed.push(parent.doneAt ?? at)

      parent.doneAt = completed.sort((
        a,
        b,
      ) => Date.parse(a) - Date.parse(b)).at(-1)
    } else {
      delete parent.doneAt
      delete parent.keepDone

      if (parent.expired) {
        delete parent.hidden
        delete parent.expired
      }
    }
  }
}

// A task's own 0 keeps it visible; the shared setting says that with off, so its 0 hides right away.
export function cardDoneDeadline({
  card,
  hours = DEFAULT_DONE_HOURS,
}: {
  card: Card
  hours?: DoneAfterHours
}): number | undefined {
  const delay = card.doneAfterHours ?? hours
  const kept = card.doneAfterHours === 0 || delay === 'off'
  const pendingOwnerChoice = openAsks({
    card,
    audience: 'owner',
  }).length > 0

  if (pendingOwnerChoice || card.hidden || card.keepDone || !card.doneAt || kept) {
    return undefined
  }

  const deadline = Date.parse(card.doneAt) + delay * HOUR_MS

  return Number.isFinite(deadline) ? deadline : undefined
}

export function doneDeadline({
  state,
  hours,
}: {
  state: TitanState
  hours: DoneAfterHours
}): number | undefined {
  let next: number | undefined

  for (const card of Object.values(state.cards)) {
    const deadline = cardDoneDeadline({
      card,
      hours,
    })

    if (deadline !== undefined) {
      next = Math.min(
        next ?? deadline,
        deadline,
      )
    }
  }

  return next
}

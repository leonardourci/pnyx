import { clip } from './digest.ts'
import { checksSettled, readyBacklog, turnEndedUndeclared, unwatchedPullRequests, wakesHydra } from './hydra.ts'
import { cardLanding, failedChecks, type Card, type HydraEvent, type HydraState, type Link } from './model.ts'
import { taskMention } from '../mentions/mentions.ts'

// The fixed words a reason line names its fact with; the skill and README list them for Hydra.
export const WAKE_KINDS = [
  'declared',
  'asked',
  'report',
  'turn ended',
  'checks',
  'comments',
  'merged',
  'approved merge is green',
  'quiet',
  'wait ended',
  'not confirmed',
  'reminder due',
  'queue released',
  'queued',
  'kind',
  'permission',
  'slot free',
] as const
export type WakeKind = (typeof WAKE_KINDS)[number]

// How much of a worker's own words a reason line quotes; the full text is on the card and in hydra check.
const QUOTE_CHARS = 200

// One line: "- [@Title](pnyx-task:id) kind: detail", the task left out when the fact names none.
export function reasonLine({
  state,
  card,
  kind,
  detail,
}: {
  state: HydraState
  card?: string
  kind: WakeKind
  detail?: string
}): string {
  const task = card ? state.cards[card] : undefined
  const ref = task ? `${taskMention({
    id: task.id,
    title: task.title,
  })} ` : ''

  return `- ${ref}${kind}${detail ? `: ${detail}` : ''}`
}

const checksDetail = ({ link }: { link: Link }) =>
  `${link.url} ${failedChecks({ checks: link.checks }) ? 'red' : 'green'} (${link.checks})`

// A task whose own rule lets Hydra merge has its approval already, so green checks are its cue.
const mergeApproved = ({
  state,
  card,
}: {
  state: HydraState
  card: Card
}) => cardLanding({
  card,
  projects: state.projects ?? [],
})?.merge === 'hydra'

function eventReasons({
  state,
  event,
}: {
  state: HydraState
  event: HydraEvent
}): {
  kind: WakeKind
  card?: string
  detail?: string
}[] {
  if (event.type === 'hydra.message') {
    const {
      task,
      ask,
      text,
    } = event.data

    const question = task ? state.cards[task]?.asks?.find(a => a.id === ask)?.question : undefined

    return [
      ask ? {
        kind: 'asked',
        card: task,
        detail: `${ask}: "${clip({
          text: question ?? text,
          size: QUOTE_CHARS,
        })}"`,
      } : {
        kind: 'report',
        card: task,
        detail: `from ${event.actor}, in its envelope below`,
      },
    ]
  }

  const card = state.cards[event.cardId]

  if (!card) {
    return []
  }

  const slotFree = () => {
    const ready = readyBacklog({ state })

    return ready.length ? [
      {
        kind: 'slot free' as const,
        detail: `ready in Backlog, in order: ${ready.map(c => taskMention({
          id: c.id,
          title: c.title,
        })).join(', ')}`,
      },
    ] : []
  }

  switch (event.type) {
    case 'task.declared': {
      const {
        state: declared,
        note,
      } = event.data

      return [
        {
          kind: 'declared',
          card: card.id,
          detail: note ? `${declared}, "${clip({
            text: note,
            size: QUOTE_CHARS,
          })}"` : declared,
        },
        ...(declared === 'done' ? slotFree() : []),
      ]
    }
    case 'task.permission':
      return [
        {
          kind: 'permission',
          card: card.id,
          detail: `${event.data.tool} waits for an answer`,
        },
      ]
    case 'task.reminder-due':
      return [
        {
          kind: 'reminder due',
          card: card.id,
          detail: clip({
            text: event.data.reminder,
            size: QUOTE_CHARS,
          }),
        },
      ]
    case 'task.queue':
      return [
        event.data.after ? {
          kind: 'queued',
          card: card.id,
          detail: `behind ${event.data.after.session}`,
        } : {
          kind: 'queue released',
          card: card.id,
        },
      ]
    case 'task.kind':
      return [
        {
          kind: 'kind',
          card: card.id,
          detail: `${event.data.before} to ${event.data.after}`,
        },
      ]
    case 'task.session':
      return slotFree()
    case 'card.linked': {
      const {
        before,
        after,
      } = event.data

      if (after?.kind !== 'github_pr') {
        return []
      }

      if (after.state === 'merged') {
        return [
          {
            kind: 'merged',
            card: card.id,
            detail: after.url,
          },
          ...slotFree(),
        ]
      }

      const unwatched = unwatchedPullRequests({ card }).length > 0
      const reasons: ReturnType<typeof eventReasons> = []
      const failed = failedChecks({ checks: after.checks })
      const failing = failed > failedChecks({ checks: before?.checks })

      if (checksSettled({
        before,
        after,
      })) {
        reasons.push(!failed && mergeApproved({
          state,
          card,
        }) ? {
            kind: 'approved merge is green',
            card: card.id,
            detail: `${after.url} (${after.checks})`,
          } : {
            kind: 'checks',
            card: card.id,
            detail: checksDetail({ link: after }),
          })
      } else if (failing && unwatched) {
        reasons.push({
          kind: 'checks',
          card: card.id,
          detail: `${checksDetail({ link: after })}, and no worker watches it`,
        })
      }

      const comments = before?.comments !== undefined ? (after.comments ?? 0) - before.comments : 0

      if (comments > 0 && unwatched) {
        reasons.push({
          kind: 'comments',
          card: card.id,
          detail: `${comments} new on ${after.url}, and no worker watches it`,
        })
      }

      return reasons
    }
    case 'card.pushed': {
      const open = ({ list }: { list?: Card['attention'] }) =>
        (list ?? []).filter(a => a.blocking && !a.answered)
      const asked = open({ list: event.data.before?.attention }).map(a => a.key)
      const questions = event.data.before?.attention
        ? open({ list: event.data.attention }).filter(a => !asked.includes(a.key))
        : []
      const reasons: ReturnType<typeof eventReasons> = questions.map(a => ({
        kind: 'asked',
        card: card.id,
        detail: `${a.key}: "${clip({
          text: a.text ?? a.questions?.map(q => q.question).join(' ') ?? a.kind,
          size: QUOTE_CHARS,
        })}"`,
      }))

      if (turnEndedUndeclared({
        card,
        event,
      })) {
        reasons.push({
          kind: 'turn ended',
          card: card.id,
          detail: card.status?.state === 'working'
            ? 'the worker finished its turn still declaring working'
            : `the worker finished its turn without a new declaration (still ${card.status?.state ?? 'undeclared'})`,
        })
      }

      const unwatched = unwatchedPullRequests({ card })

      if (event.data.activity === 'ended' && unwatched.length) {
        reasons.push({
          kind: 'turn ended',
          card: card.id,
          detail: `the worker's session ended, and no worker watches ${unwatched.map(l => l.url).join(', ')}`,
        })
      }

      return reasons
    }
    default:
      return []
  }
}

// Why Hydra is woken: one line per fact in the changes that woke it, oldest first, each fact once.
export function wakeReasons({
  state,
  events,
}: {
  state: HydraState
  events: HydraEvent[]
}): string[] {
  const lines = events.filter(event => wakesHydra({
    state,
    event,
  }))
    .flatMap(event => eventReasons({
      state,
      event,
    }))
    .map(reason => reasonLine({
      state,
      ...reason,
    }))

  return [...new Set(lines)]
}

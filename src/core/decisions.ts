import { askWording, openAsks } from './asks.ts'
import { clip } from './digest.ts'
import { HYDRA_CARD } from './hydra.ts'
import { failedChecks, pendingChecks, type Card, type HydraState } from './model.ts'
import { INTERRUPTED } from './tasks.ts'
import { mergeApproved } from './wake-reasons.ts'
import { taskMention } from '../mentions/mentions.ts'

// The fixed words a decision line names its item with; the pnyx-hydra skill and the README list them.
export type DecisionKind = 'owner question' | 'worker question' | 'permission' | 'blocking prompt' | 'approved merge'

export interface OpenDecision {
  kind: DecisionKind
  card: string
  // When it started waiting; a blocking prompt and a merge carry no time.
  at?: string
  detail: string
}

const QUOTE_CHARS = 200

// Permission requests show up as attention too; they are listed once, as permissions.
const PERMISSION_PROMPT = 'pnyx:permission:'

const quote = ({ text }: { text: string }) => `"${clip({
  text,
  size: QUOTE_CHARS,
})}"`

function cardDecisions({
  state,
  card,
}: {
  state: HydraState
  card: Card
}): OpenDecision[] {
  const asks = openAsks({ card }).map((ask): OpenDecision => {
    const choice = ask.recommended ? ask.options?.[ask.recommended - 1]?.label : undefined

    return ask.audience === 'owner' ? {
      kind: 'owner question',
      card: card.id,
      at: ask.escalated?.at ?? ask.at,
      detail: `${ask.id} ${quote({ text: askWording({ ask }).question })}${choice ? ` (recommended: ${choice})` : ''}`,
    } : {
      kind: 'worker question',
      card: card.id,
      at: ask.at,
      detail: `${ask.id} to you ${quote({ text: ask.question })}`,
    }
  })
  const permissions = (card.permissions ?? []).filter(p => p.status === 'pending').map((p): OpenDecision => ({
    kind: 'permission',
    card: card.id,
    ...(p.at ? { at: p.at } : {}),
    detail: `${p.id}: ${p.tool} waits for an answer`,
  }))
  const prompts = card.attention.filter(a => a.blocking && !a.answered && a.key !== INTERRUPTED
    && !a.key.startsWith(PERMISSION_PROMPT)).map((a): OpenDecision => ({
    kind: 'blocking prompt',
    card: card.id,
    detail: quote({ text: a.text ?? a.questions?.map(q => q.question).join(' ') ?? a.kind }),
  }))
  const merges = mergeApproved({
    state,
    card,
  }) ? card.links.filter(l => l.kind === 'github_pr' && l.state === 'open' && !l.draft).map((l): OpenDecision => {
      const { checks } = l
      let detail = 'checks green: merge it'

      if (failedChecks({ checks })) {
        detail = 'checks red'
      } else if (pendingChecks({ checks }) || !checks) {
        detail = 'waits on checks'
      }

      return {
        kind: 'approved merge',
        card: card.id,
        detail: `${l.url} ${detail}${checks ? ` (${checks})` : ''}`,
      }
    }) : []

  return [
    ...asks,
    ...permissions,
    ...prompts,
    ...merges,
  ]
}

// Everything still waiting on the owner, on Hydra or on checks, oldest first; an item with no time sorts first.
export function openDecisions({ state }: { state: HydraState }): OpenDecision[] {
  return Object.values(state.cards).filter(card => card.id !== HYDRA_CARD)
    .flatMap(card => cardDecisions({
      state,
      card,
    }))
    .sort((
      a,
      b,
    ) => (a.at ?? '').localeCompare(b.at ?? ''))
}

const age = ({
  at,
  now,
}: {
  at: string
  now: number
}) => {
  const minutes = Math.floor((now - Date.parse(at)) / 60_000)

  if (minutes < 1) {
    return 'under 1 min'
  }

  return minutes < 120 ? `${minutes} min` : `${Math.floor(minutes / 60)} h`
}

// The block every wake carries, so Hydra knows the whole list without going looking; "none" says the list is complete.
export function decisionsBlock({
  state,
  now,
}: {
  state: HydraState
  now: number
}): string {
  const items = openDecisions({ state })

  if (!items.length) {
    return 'Open decisions: none'
  }

  return [
    `Open decisions (${items.length}):`,
    ...items.map(item => {
      const card = state.cards[item.card]!
      const waited = item.at ? `, ${age({
        at: item.at,
        now,
      })} old` : ''

      return `- ${taskMention({
        id: card.id,
        title: card.title,
      })} ${item.kind}${waited}: ${item.detail}`
    }),
  ].join('\n')
}

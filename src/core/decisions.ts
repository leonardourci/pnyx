import { askWording, openAsks } from './asks.ts'
import { HYDRA_CARD } from './hydra.ts'
import { failedChecks, pendingChecks, type Attention, type Card, type HydraState, type Link } from './model.ts'
import { PERMISSION_PREFIX } from './permissions.ts'
import { INTERRUPTED, liveTask } from './tasks.ts'
import { mergeApproved, quote } from './wake-reasons.ts'
import { taskMention } from '../mentions/mentions.ts'

// The fixed words a decision line names its item with; the pnyx-hydra skill lists them.
type DecisionKind = 'owner question' | 'worker question' | 'permission' | 'blocking prompt' | 'approved merge'

export interface OpenDecision {
  kind: DecisionKind
  card: Pick<Card, 'id' | 'title'>
  // When it started waiting; a blocking prompt and a merge carry no time.
  at?: string
  detail: string
}

// A pending permission's own attention entry is left out: it is listed once, as a permission.
const waitingPrompt = ({ prompt }: { prompt: Attention }) => prompt.blocking && !prompt.answered
  && prompt.key !== INTERRUPTED && !prompt.key.startsWith(PERMISSION_PREFIX)

const asked = ({ questions }: { questions?: { question: string }[] }) => questions?.map(q => q.question).join(' ')

function mergeDetail({ link }: { link: Link }): string {
  const { checks } = link
  let state = 'checks green: merge it'

  if (failedChecks({ checks })) {
    state = 'checks red'
  } else if (pendingChecks({ checks }) || !checks) {
    state = 'waits on checks'
  }

  return `${link.url} ${state}${checks ? ` (${checks})` : ''}`
}

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
      card,
      at: ask.escalated?.at ?? ask.at,
      detail: `${ask.id} ${quote({ text: askWording({ ask }).question })}${choice ? ` (recommended: ${choice})` : ''}`,
    } : {
      kind: 'worker question',
      card,
      at: ask.at,
      detail: `${ask.id} to you ${quote({ text: ask.question })}`,
    }
  })
  const permissions = (card.permissions ?? []).filter(p => p.status === 'pending').map((p): OpenDecision => {
    const questions = asked({ questions: p.questions })

    return {
      kind: 'permission',
      card,
      at: p.at,
      detail: `${p.id} ${p.tool}${questions ? ` ${quote({ text: questions })}` : ''}`,
    }
  })
  const prompts = card.attention.filter(prompt => waitingPrompt({ prompt }))
    .map((prompt): OpenDecision => ({
      kind: 'blocking prompt',
      card,
      detail: quote({ text: prompt.text || asked({ questions: prompt.questions }) || prompt.kind }),
    }))
  const approved = mergeApproved({
    state,
    card,
  })
  const merges = approved ? card.links.filter(l => l.kind === 'github_pr' && l.state === 'open' && !l.draft)
    .map((link): OpenDecision => ({
      kind: 'approved merge',
      card,
      detail: mergeDetail({ link }),
    })) : []

  return [
    ...asks,
    ...permissions,
    ...prompts,
    ...merges,
  ]
}

// Everything on a live task still waiting on the owner, on Hydra or on checks: oldest first, then what carries no time.
export function openDecisions({ state }: { state: HydraState }): OpenDecision[] {
  const items = Object.values(state.cards)
    .filter(card => card.id !== HYDRA_CARD && liveTask({ card }))
    .flatMap(card => cardDecisions({
      state,
      card,
    }))

  return [
    ...items.filter(item => item.at).sort((
      a,
      b,
    ) => a.at!.localeCompare(b.at!)),
    ...items.filter(item => !item.at),
  ]
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

// Every wake carries this; "none" says the list is complete.
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
      const waited = item.at ? `, ${age({
        at: item.at,
        now,
      })} old` : ''

      return `- ${taskMention({
        id: item.card.id,
        title: item.card.title,
      })} ${item.kind}${waited}: ${item.detail}`
    }),
  ].join('\n')
}

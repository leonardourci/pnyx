import { askWording, openAsks } from './questions.ts'
import { HYDRA_CARD } from '../core/hydra.ts'
import type { HydraState } from '../app/model.ts'
import type { Card } from './model.ts'
import { failedChecks, pendingChecks, type Link } from './delivery/model.ts'
import type { Attention } from '../workers/model.ts'
import { PERMISSION_PREFIX } from '../workers/permission-rules.ts'
import { liveTask } from './select.ts'
import { INTERRUPTED } from '../workers/session-attachments.ts'
import { mergeApproved, quote } from '../hydra/wake-reasons.ts'
import { taskMention } from '../mentions/mentions.ts'

// The fixed words a decision line names its item with; the orchestrator skill lists them.
type DecisionKind = 'owner question' | 'worker question' | 'permission' | 'blocking prompt' | 'approved merge'

export interface OpenDecision {
  kind: DecisionKind
  id: string
  text: string
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
  if (link.mergeAttempt && link.state !== 'merged') {
    return `${link.url} ${link.mergeAttempt.outcome === 'queued' ? 'merge queued' : 'merge unconfirmed'}; wait for GitHub confirmation`
  }

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

    const wording = askWording({ ask }).question

    return ask.audience === 'owner' ? {
      kind: 'owner question',
      id: ask.id,
      text: wording,
      card,
      at: ask.escalated?.at ?? ask.at,
      detail: `${ask.id} ${quote({ text: wording })}${choice ? ` (recommended: ${choice})` : ''}`,
    } : {
      kind: 'worker question',
      id: ask.id,
      text: ask.question,
      card,
      at: ask.at,
      detail: `${ask.id} to you ${quote({ text: ask.question })}`,
    }
  })
  const permissions = (card.permissions ?? []).filter(p => p.status === 'pending').map((p): OpenDecision => {
    const questions = asked({ questions: p.questions })

    return {
      kind: 'permission',
      id: p.id,
      text: questions || `Allow ${p.tool}?`,
      card,
      at: p.at,
      detail: `${p.id} ${p.tool}${questions ? ` ${quote({ text: questions })}` : ''}`,
    }
  })
  const prompts = card.attention.filter(prompt => waitingPrompt({ prompt }))
    .map((prompt): OpenDecision => {
      const text = prompt.text || asked({ questions: prompt.questions }) || prompt.kind

      return {
        kind: 'blocking prompt',
        id: prompt.key,
        text,
        card,
        detail: quote({ text }),
      }
    })
  const merges = card.links.filter(link => link.kind === 'github_pr' && link.state === 'open' && !link.draft
    && mergeApproved({
      state,
      card,
      url: link.url,
    }))
    .map((link): OpenDecision => {
      const detail = mergeDetail({ link })

      return {
        kind: 'approved merge',
        id: link.url,
        text: detail,
        card,
        detail,
      }
    })

  return [
    ...asks.filter(item => !card.hidden
      || card.asks?.some(ask => ask.id === item.id && ask.origin)),
    ...(card.hidden ? [] : permissions),
    ...(card.hidden ? [] : prompts),
    ...(card.hidden ? [] : merges),
  ]
}

// Report choices remain owed even when an older client hid their task.
export function openDecisions({ state }: { state: HydraState }): OpenDecision[] {
  const items = Object.values(state.cards)
    .filter(card => card.id !== HYDRA_CARD
      && (liveTask({ card }) || openAsks({ card }).some(ask => ask.origin)))
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

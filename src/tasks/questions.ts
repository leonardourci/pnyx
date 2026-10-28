import { HYDRA_ACTOR, ownerActor } from '../app/actors.ts'
import type { HydraEvent, HydraState, Decision } from '../app/model.ts'
import { HydraError } from '../store/errors.ts'
import type { AnswerMessage, Ask, AskAudience, Card } from './model.ts'
import { cardLanding, type Link } from './delivery/model.ts'
import type { Question } from '../workers/model.ts'
import type { Meta } from '../app/command-meta.ts'
import { findCard } from './push-rules.ts'
import { HYDRA_CARD, hydraEvent, reportActor } from '../core/hydra.ts'

const QUESTION_MAX = 300
const CONTEXT_MAX = 1500
const DETAILS_MAX = 20_000
const OPTIONS_MAX = 8
const LABEL_MAX = 120
const ANSWER_MAX = 4000

const invalid = ({ message }: { message: string }) => new HydraError({
  message,
  code: 'VALIDATION_ERROR',
})

const text = ({
  value,
  what,
  max,
}: {
  value: string | undefined
  what: string
  max: number
}): string | undefined => {
  const trimmed = value?.trim()

  if (value !== undefined && !trimmed) {
    throw invalid({ message: `${what} is empty` })
  }

  if (trimmed && trimmed.length > max) {
    throw invalid({ message: `${what} has ${trimmed.length} characters; keep it to ${max}` })
  }

  return trimmed
}

const askableTask = ({
  state,
  ref,
}: {
  state: HydraState
  ref: string
}): Card => {
  const card = findCard({
    state,
    ref,
  })

  if (card.automaticTask || card.id === HYDRA_CARD) {
    throw new HydraError({
      message: `task not found: ${ref}`,
      code: 'NOT_FOUND',
    })
  }

  return card
}

const findAsk = ({
  card,
  id,
}: {
  card: Card
  id: string
}): Ask => {
  const ask = card.asks?.find(a => a.id === id)

  if (!ask) {
    throw new HydraError({
      message: `task ${card.id} has no question ${id}`,
      code: 'NOT_FOUND',
      help: [`Run \`pnyx-axi task show ${card.id}\` to see its questions`],
    })
  }

  return ask
}

// An answer still being sent, or one that may have landed, holds the question until someone checks.
const pendingAnswer = ({
  card,
  ask,
}: {
  card: Card
  ask: Ask
}) => card.replies?.find(r => r.answers === ask.id && (r.state === 'queued' || r.state === 'delivery_unknown'))

// undelivered: the answerer checked the worker's session and the uncertain answer never arrived.
const closed = ({
  card,
  ask,
  undelivered = false,
}: {
  card: Card
  ask: Ask
  undelivered?: boolean
}) => {
  if (ask.answered || ask.closed) {
    throw new HydraError({
      message: `question ${ask.id} on task ${card.id} is already answered`,
      code: 'ASK_CLOSED',
    })
  }

  const pending = pendingAnswer({
    card,
    ask,
  })

  if (pending && !undelivered) {
    throw new HydraError({
      message: `an answer to ${ask.id} is ${pending.state === 'queued' ? 'still being sent' : 'of unknown delivery'}; nothing was sent`,
      code: 'SESSION_WAITING',
      help: ['Check the worker\'s session; if that answer never arrived, repeat with --undelivered'],
    })
  }
}

export const openAsks = ({
  card,
  audience,
}: {
  card: Card
  audience?: AskAudience
}) => (card.asks ?? []).filter(a =>
  !a.answered && !a.closed && (!audience || a.audience === audience))

export function decideAsk({
  state,
  ref,
  id,
  audience,
  fromReport,
  kind,
  question,
  context,
  details,
  options,
  recommended,
  meta,
}: {
  state: HydraState
  ref: string
  id: string
  kind?: string
  audience: AskAudience
  fromReport?: string
  question: string
  context?: string
  details?: string
  options?: Question['options']
  recommended?: number
  meta: Meta
}): Decision {
  const card = askableTask({
    state,
    ref,
  })

  let origin: Ask['origin']

  if (fromReport !== undefined) {
    if (audience !== 'owner') {
      throw invalid({ message: '--from-report links an owner question; ask Hydra to file it on separate gated work' })
    }

    const source = askableTask({
      state,
      ref: fromReport,
    })

    if (source.id === card.id || !source.report) {
      throw invalid({ message: '--from-report must name a different task with a stored report' })
    }

    origin = {
      task: source.id,
      report: source.report.id,
    }
  }

  if (audience === 'owner' && meta.actor !== HYDRA_ACTOR) {
    throw new HydraError({
      message: 'only Hydra asks the owner directly; ask Hydra, which escalates what the owner must decide',
      code: 'OWNER_ONLY',
      help: [`Run \`pnyx-axi task ask ${card.id} --question "<question>"\` without --to owner`],
    })
  }

  if (audience === 'hydra' && meta.actor === HYDRA_ACTOR) {
    throw invalid({ message: 'Hydra asks the owner: pass --to owner' })
  }

  // Hydra hears a question as its asker's report, so only an agent's question goes to Hydra.
  if (audience === 'hydra' && !reportActor({ actor: meta.actor })) {
    throw new HydraError({
      message: 'a question to Hydra comes from the task\'s worker; the owner talks to Hydra in its chat',
      code: 'NOT_ALLOWED',
      help: [`A worker Pnyx does not run passes --actor worker:${card.id}`],
    })
  }

  if (kind !== undefined && kind !== 'go') {
    throw invalid({ message: '--kind takes go for an owner go question' })
  }

  if (kind === 'go' && (audience !== 'owner' || !card.hold)) {
    throw invalid({ message: 'a go question is for the owner on a held card' })
  }

  if (kind === 'go' && openAsks({ card }).some(ask => ask.kind === 'go')) {
    throw invalid({ message: 'this card already has an open go question' })
  }

  if (kind === 'go' && (options?.length || recommended !== undefined)) {
    throw invalid({ message: 'a go question supplies its own Go and Hold choices' })
  }

  const choices = (kind === 'go' ? [
    { label: 'Go' },
    { label: 'Hold' },
  ] : options ?? []).map(option => ({
    label: text({
      value: option.label,
      what: 'a choice',
      max: LABEL_MAX,
    })!,
    ...(option.description?.trim() ? {
      description: text({
        value: option.description,
        what: 'a choice description',
        max: QUESTION_MAX,
      }),
    } : {}),
  }))

  if (choices.length > OPTIONS_MAX) {
    throw invalid({ message: `use at most ${OPTIONS_MAX} choices` })
  }

  if (new Set(choices.map(c => c.label)).size !== choices.length) {
    throw invalid({ message: 'choices must have different labels' })
  }

  const fits = Number.isInteger(recommended) && recommended! >= 1 && recommended! <= choices.length

  if (recommended !== undefined && !fits) {
    throw invalid({ message: choices.length ? `--recommend takes a choice number from 1 to ${choices.length}` : '--recommend needs choices' })
  }

  const said = {
    question: text({
      value: question,
      what: 'the question',
      max: QUESTION_MAX,
    }),
    context: text({
      value: context,
      what: '--context',
      max: CONTEXT_MAX,
    }),
    details: text({
      value: details,
      what: '--details',
      max: DETAILS_MAX,
    }),
  }

  if (!said.question) {
    throw invalid({ message: 'the question is empty' })
  }

  return hydraEvent({
    state,
    meta,
    cardId: card.id,
    change: {
      type: 'task.asked',
      data: {
        id,
        audience,
        ...(origin ? { origin } : {}),
        ...(kind === 'go' ? {
          kind,
          hold: structuredClone(card.hold),
        } : {}),
        question: said.question,
        ...(said.context ? { context: said.context } : {}),
        ...(said.details ? { details: said.details } : {}),
        ...(choices.length ? { options: choices } : {}),
        ...(recommended ? { recommended } : {}),
      },
    },
  })
}

export function decideEscalation({
  state,
  ref,
  ask: id,
  question,
  context,
  undelivered,
  meta,
}: {
  state: HydraState
  ref: string
  ask: string
  question?: string
  context?: string
  undelivered?: boolean
  meta: Meta
}): Decision {
  const card = askableTask({
    state,
    ref,
  })
  const ask = findAsk({
    card,
    id,
  })

  if (meta.actor !== HYDRA_ACTOR) {
    throw new HydraError({
      message: 'only Hydra escalates a question to the owner',
      code: 'NOT_ALLOWED',
    })
  }

  closed({
    card,
    ask,
    undelivered,
  })

  if (ask.audience === 'owner') {
    throw new HydraError({
      message: `question ${ask.id} already waits for the owner`,
      code: 'ASK_CLOSED',
    })
  }

  const owner = {
    question: text({
      value: question,
      what: '--question',
      max: QUESTION_MAX,
    }),
    context: text({
      value: context,
      what: '--context',
      max: CONTEXT_MAX,
    }),
  }

  return hydraEvent({
    state,
    meta,
    cardId: card.id,
    change: {
      type: 'task.ask.escalated',
      data: {
        ask: ask.id,
        ...(owner.question ? { question: owner.question } : {}),
        ...(owner.context ? { context: owner.context } : {}),
      },
    },
  })
}

export const askReport = ({
  task,
  ask,
  hydraId,
}: {
  task: string
  ask: Pick<Ask, 'id' | 'question' | 'context' | 'details' | 'options' | 'recommended'>
  hydraId: string
}) => [
  `Question ${ask.id}: ${ask.question}`,
  ...(ask.context ? [ask.context] : []),
  ...(ask.options ?? []).map((
    o,
    i,
  ) => `${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ''}${ask.recommended === i + 1 ? ' (recommended)' : ''}`),
  ...(ask.details ? [`Details: \`pnyx-axi task show ${task} --full --hydra ${hydraId}\``] : []),
  `Answer: \`pnyx-axi task answer ${task} ${ask.id} --choice <n> | --text "<answer>" --reason "<why>" --hydra ${hydraId}\`; hand on only an owner decision: \`pnyx-axi task escalate ${task} ${ask.id} --reason "<why>" --hydra ${hydraId}\``,
].join('\n')

export const askWording = ({ ask }: { ask: Ask }) => ({
  question: ask.escalated?.question ?? ask.question,
  context: ask.escalated?.context ?? ask.context,
})

export function askAnswer({
  card,
  id,
  actor,
  choice,
  text: typed,
  undelivered,
  state,
  fromMessage,
}: {
  card: Card
  id: string
  actor: string
  choice?: string
  text?: string
  undelivered?: boolean
  state?: HydraState
  fromMessage?: string
}): {
  text: string
  decision: {
    questionId: string
    fromMessage?: AnswerMessage
    question: string
    answer: string
    choice?: string
  }
} {
  const ask = findAsk({
    card,
    id,
  })

  if (actor.startsWith('helper:') && (ask.audience !== 'hydra' || ask.escalated)) {
    throw new HydraError({
      message: 'The helper cannot answer an owner decision',
      code: 'OWNER_ONLY',
    })
  }

  if (reportActor({ actor }) || actor === 'pnyx') {
    throw new HydraError({
      message: 'an agent cannot answer a question; Hydra or the owner answers it',
      code: 'NOT_ALLOWED',
    })
  }

  let source: AnswerMessage | undefined

  if (fromMessage !== undefined) {
    const message = state?.hydraMessages?.find(message => message.id === fromMessage)
    const ownerMessage = message && ownerActor({ actor: message.actor }) && message.action === 'send'
    const askedAt = ask.escalated?.at ?? ask.at
    const newer = message && Date.parse(message.at) > Date.parse(askedAt)

    if (actor !== HYDRA_ACTOR || ask.audience !== 'owner') {
      throw invalid({ message: '--from-message is for Hydra recording an owner answer to an owner question' })
    }

    if (!ownerMessage || !newer) {
      throw invalid({ message: '--from-message must name the owner’s own message sent after the question' })
    }

    if (typed !== undefined || (choice !== undefined && ask.kind !== 'merge' && ask.kind !== 'go')) {
      throw invalid({ message: '--from-message quotes the owner’s message; a merge or go question also takes --choice' })
    }

    source = {
      id: message.id,
      text: message.text,
      at: message.at,
    }
  }

  if (ask.audience === 'owner' && actor === HYDRA_ACTOR && !source) {
    throw new HydraError({
      message: `question ${ask.id} waits for the owner's own answer`,
      code: 'OWNER_ONLY',
      help: ['Use --from-message <id> only when the owner’s own newer message answers this question'],
    })
  }

  closed({
    card,
    ask,
    undelivered,
  })

  const options = ask.options ?? []
  const picked = choice?.trim()
  const index = picked === undefined ? undefined
    : /^\d+$/.test(picked) ? Number(picked) - 1 : options.findIndex(o => o.label === picked)

  if (index !== undefined && !options[index]) {
    throw invalid({ message: options.length ? `--choice takes a number from 1 to ${options.length} or a choice's label` : `question ${ask.id} has no choices; answer with --text` })
  }

  const note = text({
    value: source?.text ?? typed,
    what: '--text',
    max: ANSWER_MAX,
  })
  const label = index === undefined ? undefined : options[index]!.label

  if (!label && !note) {
    throw invalid({ message: 'answer with --choice, --text or both' })
  }

  if (ask.kind === 'merge' && !label && note !== 'Merge' && note !== 'Hold') {
    throw invalid({ message: 'answer a merge question with --choice Merge or Hold; --from-message also needs that choice' })
  }

  if (ask.kind === 'go') {
    if (!card.hold || card.hold.id !== ask.hold?.id) {
      throw invalid({ message: 'this go question no longer names the current hold' })
    }

    if (!label && note !== 'Go' && note !== 'Hold') {
      throw invalid({ message: 'answer a go question with --choice Go or Hold; --from-message also needs that choice' })
    }

    if (source && Date.parse(source.at) <= Date.parse(card.hold.at)) {
      throw invalid({ message: 'the owner’s message must be newer than the current hold' })
    }
  }

  let by = actor

  if (source || ownerActor({ actor })) {
    by = 'the owner'
  } else if (actor === HYDRA_ACTOR) {
    by = 'Hydra'
  }

  return {
    text: [
      `Answer from ${by} to your question ${ask.id}: ${ask.question}`,
      ...(label ? [`Choice: ${label}`] : []),
      ...(note ? [note] : []),
    ].join('\n'),
    decision: {
      questionId: ask.id,
      question: askWording({ ask }).question,
      answer: note ?? label!,
      ...(label ? { choice: label } : {}),
      fromMessage: source,
    },
  }
}

export function applyAsk({
  state,
  event,
}: {
  state: HydraState
  event: HydraEvent
}): boolean {
  // Returns false so applyHydra still records the owner's answering message.
  if (event.type === 'hydra.message') {
    const card = event.data.answers && event.data.task ? state.cards[event.data.task] : undefined

    if (card?.asks) {
      card.asks = card.asks.map(a => {
        if (a.id !== event.data.answers) {
          return a
        }

        const answered = {
          ...a,
          answered: event.id,
          answeredAt: event.at,
          fromMessage: event.data.fromMessage,
        }

        if (event.data.choice !== undefined) {
          answered.choice = event.data.choice
        } else if (a.kind === 'merge' || a.kind === 'go') {
          answered.choice = event.data.text
        }

        if (a.kind === 'go' && answered.choice === 'Go' && card.hold?.id === a.hold?.id) {
          delete card.hold
        }

        return answered
      })
    }

    return false
  }

  if (event.type !== 'task.asked' && event.type !== 'task.ask.escalated'
    && event.type !== 'task.ask.closed' && event.type !== 'task.ask.reopened') {
    return false
  }

  const card = state.cards[event.cardId]

  if (!card) {
    return true
  }

  if (event.type === 'task.asked') {
    if (!card.asks?.some(a => a.id === event.data.id)) {
      card.asks = [
        ...(card.asks ?? []),
        {
          ...structuredClone(event.data),
          at: event.at,
          actor: event.actor,
        },
      ]
    }
  } else if (event.type === 'task.ask.closed' && card.asks) {
    card.asks = card.asks.map(a => a.id === event.data.ask ? {
      ...a,
      closed: {
        id: event.id,
        at: event.at,
        reason: event.data.reason,
        evidence: event.data.evidence,
      },
    } : a)
  } else if (event.type === 'task.ask.reopened' && card.asks) {
    card.asks = card.asks.map(a => {
      if (a.id !== event.data.ask || a.answered !== event.data.answer) {
        return a
      }

      if (a.kind === 'go' && a.choice === 'Go' && a.hold && !card.hold) {
        card.hold = structuredClone(a.hold)
      }

      const reopened = { ...a }
      delete reopened.answered
      delete reopened.answeredAt
      delete reopened.fromMessage
      delete reopened.choice

      return reopened
    })
  } else if (event.type === 'task.ask.escalated' && card.asks) {
    card.asks = card.asks.map(a => (a.id === event.data.ask ? {
      ...a,
      audience: 'owner',
      escalated: {
        id: event.id,
        at: event.at,
        actor: event.actor,
        ...(event.reason ? { reason: event.reason } : {}),
        ...(event.data.question ? { question: event.data.question } : {}),
        ...(event.data.context ? { context: event.data.context } : {}),
      },
    } : a))
  }

  card.revision++
  card.updatedSeq = event.seq
  card.updatedAt = event.at

  return true
}

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

  if (!card || card.id === HYDRA_CARD || card.automaticTask || state.config?.hydra.kind === 'firstmate') {
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
  link,
  id,
}: {
  link: Link
  id: string
}): Extract<HydraEvent, { type: 'task.asked' }>['data'] {
  const number = link.url.split('/').at(-1)

  return {
    id,
    audience: 'owner',
    kind: 'merge',
    url: link.url,
    question: `Review and merge PR #${number}?`,
    context: `${link.url}\nChecks: ${link.checks ?? 'not read yet'}`,
    options: [
      { label: 'Merge' },
      { label: 'Hold' },
    ],
  }
}

export function decideAskClosure({
  state,
  ref,
  id,
  evidence,
  reopen,
  answer,
  meta,
}: {
  state: HydraState
  ref: string
  id: string
  evidence?: string
  reopen?: boolean
  answer?: string
  meta: Meta
}): Decision {
  const card = askableTask({
    state,
    ref,
  })
  const ask = findAsk({
    card,
    id,
  })

  if (reopen) {
    const currentAnswer = ask.fromMessage && ask.answered && ask.answered === answer && !ask.closed

    if (!ownerActor({ actor: meta.actor }) || !currentAnswer || !answer) {
      throw invalid({ message: 'only the owner can undo the current answer recorded from their message' })
    }

    return hydraEvent({
      state,
      cardId: card.id,
      meta,
      change: {
        type: 'task.ask.reopened',
        data: {
          ask: id,
          answer,
        },
      },
    })
  }

  if (meta.actor !== HYDRA_ACTOR || !meta.reason?.trim() || !evidence?.trim()) {
    throw invalid({ message: 'Hydra closes a moot question with --reason and --evidence' })
  }

  closed({
    card,
    ask,
  })

  return hydraEvent({
    state,
    cardId: card.id,
    meta,
    change: {
      type: 'task.ask.closed',
      data: {
        ask: id,
        reason: meta.reason,
        evidence,
      },
    },
  })
}

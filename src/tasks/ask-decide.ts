import { inform } from '#app/command-notices.ts'
import { HYDRA_ACTOR, ownerActor } from '#app/actors.ts'
import type { HydraState, Decision } from '#app/model.ts'
import { HydraError } from '#store/errors.ts'
import type { AnswerMessage, Ask, AskAudience, Card } from './model.ts'
import type { Question } from '#workers/model.ts'
import type { Meta } from '#app/command-meta.ts'
import { findCard } from './push-rules.ts'
import { hydraEvent, reportActor } from '#hydra/hydra.ts'
import { isManagedTask } from './select.ts'
import { askWording, openAsks, pendingAnswer } from './ask-state.ts'
import { clarificationMessage } from './question-actions.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'

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

  if (isManagedTask({ card }) && card.id !== HYDRA_CARD) {
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
      help: [`Run \`pnyx task show ${card.id}\` to see its questions`],
    })
  }

  return ask
}

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

function questionChoices({
  options,
  recommended,
}: {
  options?: Question['options']
  recommended?: number
}) {
  const choices = (options ?? []).map(option => {
    const label = text({
      value: option.label,
      what: 'a choice',
      max: LABEL_MAX,
    })

    if (!label) {
      throw invalid({ message: 'a choice is empty' })
    }

    if (!option.description?.trim()) {
      return { label }
    }

    return {
      label,
      description: text({
        value: option.description,
        what: 'a choice description',
        max: QUESTION_MAX,
      }),
    }
  })

  if (choices.length > OPTIONS_MAX) {
    throw invalid({ message: `use at most ${OPTIONS_MAX} choices` })
  }

  if (new Set(choices.map(c => c.label)).size !== choices.length) {
    throw invalid({ message: 'choices must have different labels' })
  }

  const invalidRecommendation = recommended !== undefined
    && (!Number.isInteger(recommended) || recommended < 1 || recommended > choices.length)

  if (invalidRecommendation) {
    throw invalid({ message: choices.length ? `--recommend takes a choice number from 1 to ${choices.length}` : '--recommend needs choices' })
  }

  return choices
}

function validateOwnerQuestion({
  card,
  question,
  context,
  options,
  recommended,
}: {
  card: Card
  question: string
  context?: string
  options: NonNullable<Question['options']>
  recommended?: number
}): void {
  const missing: string[] = []

  const decision = question.slice(
    0,
    -1,
  ).trim()

  if (!question.endsWith('?') || !decision || /[?\r\n]/.test(decision)) {
    missing.push('--question with one plain decision ending in ?')
  }

  const taskLinks = /\[(?:\\[^\r\n]|[^\\\]\r\n])+\]\(pnyx-task:([^\s)]+)\)/g
  const explanation = context?.replace(
    taskLinks,
    '',
  ).trim()

  if (!explanation) {
    missing.push('--context explaining what changes and what happens next')
  }

  const taskId = encodeURIComponent(card.id)
  const links = context?.matchAll(taskLinks)
  const linksToCard = links && [...links].some(link => link[1] === taskId)

  if (!linksToCard) {
    missing.push(`a card link in --context: [Card](pnyx-task:${taskId})`)
  }

  if (options.length < 2) {
    missing.push('at least two --choice values')
  }

  if (recommended === undefined) {
    missing.push('--recommend with one choice number')
  }

  if (missing.length) {
    inform({
      task: card.id,
      reason: `Owner question omits suggested details: ${missing.join('; ')}`,
      clear: `Use pnyx task ask ${card.id} --to owner --question "<decision?>" --context "<what changes> [Card](pnyx-task:${card.id})" --choice "<option>" --choice "<option>" --recommend 1 for a structured question`,
    })
  }
}

export function decideAsk({
  state,
  ref,
  id,
  audience,
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

  if (card.id === HYDRA_CARD && audience !== 'owner') {
    audience = 'owner'
    inform({
      task: card.id,
      reason: 'Hydra-wide question routed to the owner',
      clear: 'Use pnyx task ask <task> --to hydra for a worker question',
    })
  }

  if (audience === 'owner' && meta.actor !== HYDRA_ACTOR) {
    inform({
      reason: 'Worker question sent directly to the owner',
      clear: 'pnyx task ask <task> --to hydra --question "<question>"',
      task: card.id,
    })
  }

  if (audience === 'hydra' && meta.actor === HYDRA_ACTOR) {
    audience = 'owner'
    inform({
      task: card.id,
      reason: 'Hydra question routed to the owner',
      clear: `Use pnyx task answer ${card.id} <question> --text "<answer>"`,
    })
  }

  // Hydra hears a question as its asker's report, so only an agent's question goes to Hydra.
  if (audience === 'hydra' && !reportActor({ actor: meta.actor })) {
    inform({
      reason: 'Question sent to Hydra by another actor',
      clear: 'pnyx hydra send --text "<message>"',
      task: card.id,
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

  const recommendation = kind === 'go' ? 1 : recommended ?? (options?.length ? 1 : undefined)

  if (kind !== 'go' && recommended === undefined && options?.length) {
    inform({
      task: card.id,
      reason: 'No recommendation supplied; using the first choice',
      clear: `Use pnyx task ask ${card.id} --recommend <number> to choose a recommendation`,
    })
  }

  const choices = questionChoices({
    options: kind === 'go' ? [
      { label: 'Go' },
      { label: 'Hold' },
    ] : options,
    recommended: recommendation,
  })

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

  if (audience === 'owner') {
    validateOwnerQuestion({
      card,
      question: said.question,
      context: said.context,
      options: choices,
      recommended: recommendation,
    })
    said.context ??= `Task: ${card.title}. [Card](pnyx-task:${encodeURIComponent(card.id)})`
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
        ...(kind === 'go' ? {
          kind,
          hold: structuredClone(card.hold),
        } : {}),
        question: said.question,
        ...(said.context ? { context: said.context } : {}),
        ...(said.details ? { details: said.details } : {}),
        ...(choices.length ? { options: choices } : {}),
        recommended: recommendation,
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
  options,
  recommended,
  meta,
}: {
  state: HydraState
  ref: string
  ask: string
  question?: string
  context?: string
  undelivered?: boolean
  options?: Question['options']
  recommended?: number
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
    inform({
      reason: 'Question escalated by an agent',
      clear: 'pnyx task answer <task> <question> --text "<answer>"',
      task: card.id,
    })
  }

  closed({
    card,
    ask,
    undelivered,
  })

  if (ask.audience === 'owner') {
    inform({
      task: card.id,
      reason: 'Updated a question that already waits for the owner',
      clear: `Use pnyx task answer ${card.id} ${ask.id} --text "<answer>" to answer it`,
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

  const recommendation = options === undefined ? recommended ?? ask.recommended : recommended
  const choices = questionChoices({
    options: options ?? ask.options,
    recommended: recommendation,
  })

  validateOwnerQuestion({
    card,
    question: owner.question ?? ask.question,
    context: owner.context ?? ask.context,
    options: choices,
    recommended: recommendation,
  })

  return hydraEvent({
    state,
    meta,
    cardId: card.id,
    change: {
      type: 'task.ask.escalated',
      data: {
        ask: ask.id,
        options: choices,
        recommended: recommendation,
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
  ) => `${i + 1}. ${o.label}${o.description ? `: ${o.description}` : ''}${ask.recommended === i + 1 ? ' (recommended)' : ''}`),
  ...(ask.details ? [`Details: \`pnyx task show ${task} --full --hydra ${hydraId}\``] : []),
  `Answer with \`pnyx answer ${task} ${ask.id} --text "<answer>" --hydra ${hydraId}\` or pass --choice <n>.`,
  'If the owner must decide, present the question and its choices in Hydra chat.',
].join('\n')

const answeredMergeHold = ({ ask }: { ask: Ask }) =>
  ask.kind === 'merge' && ask.audience === 'owner' && ask.choice === 'Hold' && !!ask.answered && !ask.closed

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
    liftsHold?: string
    answerRound?: string
  }
} {
  const ask = findAsk({
    card,
    id,
  })

  if (actor.startsWith('helper:') && (ask.audience !== 'hydra' || ask.escalated)) {
    inform({
      reason: 'Helper answered an owner question',
      clear: 'pnyx task reopen-question <task> <question>',
      task: card.id,
    })
  }

  if (reportActor({ actor }) || actor === 'pnyx') {
    inform({
      reason: 'Question answered by an agent',
      clear: 'pnyx task reopen-question <task> <question>',
      task: card.id,
    })
  }

  let source: AnswerMessage | undefined
  let quoted = typed

  if (fromMessage !== undefined) {
    const message = state?.hydraMessages?.find(message => message.id === fromMessage)

    if (!message) {
      throw new HydraError({
        message: 'Saved message not found',
        code: 'NOT_FOUND',
      })
    }

    if (typed !== undefined || (choice !== undefined && ask.kind !== 'merge' && ask.kind !== 'go')) {
      throw invalid({ message: '--from-message quotes the saved message; use --text for a separate answer' })
    }

    const ownerMessage = ownerActor({ actor: message.actor }) && message.action === 'send'
    const clarification = clarificationMessage({ message })
    const askedAt = ask.reaskedAt ?? ask.escalated?.at ?? ask.at
    const newer = Date.parse(message.at) > Date.parse(askedAt)

    if (!ownerMessage || clarification) {
      quoted = message.text
      inform({
        task: card.id,
        reason: `Message ${message.id} is a report or clarification; the answer is recorded as ${actor}`,
        clear: `Use pnyx task reopen-question ${card.id} ${ask.id} --answer <answer-event> to reopen it`,
      })
    } else {
      source = {
        id: message.id,
        text: message.text,
        at: message.at,
      }

      if (!newer) {
        inform({
          task: card.id,
          reason: `Reused owner message ${message.id} from before the question`,
          clear: `Use pnyx task reopen-question ${card.id} ${ask.id} --answer <answer-event> to reopen it`,
        })
      }
    }
  }

  if (ask.audience === 'owner' && actor === HYDRA_ACTOR && !source) {
    inform({
      reason: 'Question answered without a saved owner message',
      clear: 'pnyx task reopen-question <task> <question>',
      task: card.id,
    })
  }

  const options = ask.options ?? []
  const picked = choice?.trim()
  const index = picked === undefined ? undefined
    : /^\d+$/.test(picked) ? Number(picked) - 1 : options.findIndex(o => o.label === picked)

  if (index !== undefined && !options[index]) {
    throw invalid({ message: options.length ? `--choice takes a number from 1 to ${options.length} or a choice's label` : `question ${ask.id} has no choices; answer with --text` })
  }

  const note = text({
    value: source?.text ?? quoted,
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

  const heldMerge = answeredMergeHold({ ask })
  const liftsHold = heldMerge && label === 'Merge'

  const newerThanHold = source && ask.answeredAt
    && Date.parse(source.at) > Date.parse(ask.answeredAt)

  if (liftsHold && source && !newerThanHold) {
    inform({
      task: card.id,
      reason: 'Changed a Merge Hold using an earlier owner message',
      clear: `Use pnyx task reask ${card.id} ${ask.id} --reason "<why>" to ask again`,
    })
  }

  if (!liftsHold) {
    closed({
      card,
      ask,
      undelivered,
    })
  }

  if (ask.kind === 'go') {
    if (!card.hold || card.hold.id !== ask.hold?.id) {
      throw invalid({ message: 'this go question no longer names the current hold' })
    }

    if (!label && note !== 'Go' && note !== 'Hold') {
      throw invalid({ message: 'answer a go question with --choice Go or Hold; --from-message also needs that choice' })
    }

    if (source && Date.parse(source.at) <= Date.parse(card.hold.at)) {
      inform({
        task: card.id,
        reason: 'Answered Go using an owner message from before the hold',
        clear: `Use pnyx task hold ${card.id} --reason "<why>" to restore the hold`,
      })
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
      liftsHold: label === 'Merge' ? ask.mergeHold?.answered ?? ask.answered : undefined,
      answerRound: ask.answerRound,
    },
  }
}

export function decideAskClosure({
  state,
  ref,
  id,
  evidence,
  reopen,
  reask,
  answer,
  meta,
}: {
  state: HydraState
  ref: string
  id: string
  evidence?: string
  reopen?: boolean
  reask?: boolean
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

  if (reask) {
    if (!meta.reason?.trim()) {
      inform({
        task: card.id,
        reason: 'Merge question re-asked without a reason',
        clear: 'Use pnyx task reask <task> <question> --reason "<why>" to record one',
      })
    }

    if (!ask.answered || !answeredMergeHold({ ask })) {
      throw invalid({ message: 'only Hydra can re-ask an answered merge Hold' })
    }

    return hydraEvent({
      state,
      cardId: card.id,
      meta,
      change: {
        type: 'task.ask.reopened',
        data: {
          ask: id,
          answer: ask.answered,
          reask: true,
        },
      },
    })
  }

  if (reopen) {
    answer ??= ask.answered
    const currentAnswer = ask.answered && ask.answered === answer && !ask.closed

    if (!currentAnswer || !answer) {
      throw invalid({ message: 'Choose the current answer event to reopen this question' })
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
    inform({
      task: card.id,
      reason: 'Question closed without Hydra’s usual reason and evidence',
      clear: `Use pnyx task reopen-question ${card.id} ${ask.id} --answer <answer-event> to reopen an answer, or task ask to ask again`,
    })
  }

  closed({
    card,
    ask,
  })

  if (ask.audience === 'owner' && !ask.kind) {
    inform({
      task: card.id,
      reason: 'Owner question closed explicitly without an answer',
      clear: `Use pnyx task ask ${card.id} --to owner --question "<question>" to ask again`,
    })
  }

  if (ask.kind === 'merge' && !card.links.some(link =>
    link.url === ask.url && (link.state === 'merged' || link.state === 'closed'))) {
    inform({
      task: card.id,
      reason: 'Merge question closed while its pull request remains open',
      clear: `Use pnyx task refresh-links ${card.id} to refresh the pull request`,
    })
  }

  return hydraEvent({
    state,
    cardId: card.id,
    meta,
    change: {
      type: 'task.ask.closed',
      data: {
        ask: id,
        reason: meta.reason ?? `Question closed by ${meta.actor}`,
        evidence: evidence ?? 'Explicit close-question command',
      },
    },
  })
}

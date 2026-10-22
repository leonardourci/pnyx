import { HydraError, HYDRA_ACTOR, ownerActor, type Ask, type AskAudience, type Card, type HydraEvent, type HydraState, type Question } from './model.ts'
import { findCard, type Decision, type Meta } from './decide.ts'
import { HYDRA_CARD, hydraEvent, reportActor } from './hydra.ts'

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
  if (ask.answered) {
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
}) => (card.asks ?? []).filter(a => !a.answered && (!audience || a.audience === audience))

// A worker asks Hydra; only Hydra asks the owner directly, so a worker never bypasses it.
export function decideAsk({
  state,
  ref,
  id,
  audience,
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

  const choices = (options ?? []).map(option => ({
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
        question: said.question,
        ...(said.context ? { context: said.context } : {}),
        ...(said.details ? { details: said.details } : {}),
        ...(choices.length ? { options: choices } : {}),
        ...(recommended ? { recommended } : {}),
      },
    },
  })
}

// Hydra hands a worker's question to the owner; the worker's wording and origin stay as asked.
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

// What Hydra reads for a worker's question, built from its asking alone; Pnyx delivers it as the
// worker's report, with the commands that answer or hand it on.
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

// The wording the current audience reads: the owner sees Hydra's escalation, when it has one.
export const askWording = ({ ask }: { ask: Ask }) => ({
  question: ask.escalated?.question ?? ask.question,
  context: ask.escalated?.context ?? ask.context,
})

// Checks one answer and builds the message the asker receives. Hydra answers only what was asked
// of it; agents never answer, so a worker cannot answer its own question.
export function askAnswer({
  card,
  id,
  actor,
  choice,
  text: typed,
  undelivered,
}: {
  card: Card
  id: string
  actor: string
  choice?: string
  text?: string
  undelivered?: boolean
}): {
  text: string
  decision: {
    questionId: string
    question: string
    answer: string
    choice?: string
  }
} {
  const ask = findAsk({
    card,
    id,
  })

  if (reportActor({ actor }) || actor === 'pnyx') {
    throw new HydraError({
      message: 'an agent cannot answer a question; Hydra or the owner answers it',
      code: 'NOT_ALLOWED',
    })
  }

  if (ask.audience === 'owner' && actor === HYDRA_ACTOR) {
    throw new HydraError({
      message: `question ${ask.id} waits for the owner's own answer`,
      code: 'OWNER_ONLY',
      help: ['Tell the owner it waits in the task; do not answer it for them'],
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
    value: typed,
    what: '--text',
    max: ANSWER_MAX,
  })
  const label = index === undefined ? undefined : options[index]!.label

  if (!label && !note) {
    throw invalid({ message: 'answer with --choice, --text or both' })
  }

  const by = actor === HYDRA_ACTOR ? 'Hydra' : ownerActor({ actor }) ? 'the owner' : actor

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
  // The owner's answer to Hydra's own question is a message to Hydra; it resolves the question, and
  // applyHydra still records the message.
  if (event.type === 'hydra.message') {
    const card = event.data.answers && event.data.task ? state.cards[event.data.task] : undefined

    if (card?.asks) {
      card.asks = card.asks.map(a => (a.id === event.data.answers ? {
        ...a,
        answered: event.id,
      } : a))
    }

    return false
  }

  if (event.type !== 'task.asked' && event.type !== 'task.ask.escalated') {
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
  } else if (card.asks) {
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

import type { HydraEvent, HydraState } from '#app/model.ts'
import { askWording } from '#tasks/ask-state.ts'
import { ownerActor } from '#app/actors.ts'
import { needsMain } from '#routine-helper/state.ts'
import { HYDRA_CARD } from './identity.ts'

const CONTEXT_NOTE_LIMIT = 20
const CONTEXT_NOTE_CHARS = 400
const QUESTION_CHARS = 90
const ANSWER_CHARS = 180

export interface ContextNote {
  id: string
  seq: number
  text: string
}

function line({
  text,
  limit = CONTEXT_NOTE_CHARS,
}: {
  text: string
  limit?: number
}): string {
  const clean = text.replace(
    /\s+/g,
    ' ',
  ).trim()

  return clean.length > limit ? `${clean.slice(
    0,
    limit - 1,
  )}…` : clean
}

export function applyContextNotes({
  state,
  event,
}: {
  state: HydraState
  event: HydraEvent
}): void {
  if (event.type === 'hydra.context-delivered') {
    state.contextNotes = (state.contextNotes ?? []).filter(note => note.seq > event.data.through)

    return
  }

  const add = ({
    id = event.id,
    text,
  }: {
    id?: string
    text: string
  }) => {
    const notes = state.contextNotes ?? []

    if (notes.some(note => note.id === id)) {
      return
    }

    state.contextNotes = [
      ...notes,
      {
        id,
        seq: event.seq,
        text: line({ text }),
      },
    ].slice(-CONTEXT_NOTE_LIMIT)
  }

  const answered = ({
    id,
    title,
    question,
    answer,
  }: {
    id?: string
    title: string
    question: string
    answer: string
  }) => add({
    id,
    text: `Owner answered ${line({
      text: title,
      limit: QUESTION_CHARS,
    })}, "${line({
      text: question,
      limit: QUESTION_CHARS,
    })}": ${line({
      text: answer,
      limit: ANSWER_CHARS,
    })}`,
  })

  const card = state.cards[event.cardId]

  if (event.type === 'task.permission' && card && card.id !== HYDRA_CARD
    && event.data.status === 'allow' && ownerActor({ actor: event.actor })) {
    const pending = card.permissions?.find(request => request.id === event.data.id
      && request.session === event.data.session && request.status === 'pending')

    for (const [
      index,
      answer,
    ] of (event.data.answers ?? []).entries()) {
      const question = pending?.questions?.[index]

      if (question) {
        answered({
          id: `${event.id}:${index}`,
          title: card.title,
          question: question.question,
          answer: answer.join('; '),
        })
      }
    }
  }

  if (event.type === 'task.wait-resumed' && card?.wait?.id === event.data.wait) {
    add({ text: `${card.title}: worker resume queued. ${event.data.message.text}` })
  }

  if (event.type === 'hydra.helper-finished' && !event.data.error) {
    for (const outcome of event.data.outcomes) {
      if (needsMain({ outcome })) {
        continue
      }

      const previous = state.helper?.outcomes.findLast(item => item.task === outcome.task)

      const previousSummary = previous && line({ text: previous.summary })
      const sameSummary = previousSummary === line({ text: outcome.summary })

      if (previous && previous.status === outcome.status && sameSummary) {
        continue
      }

      add({
        id: `${event.id}:${outcome.task}`,
        text: `Routine helper, ${state.cards[outcome.task]?.title ?? outcome.task}: ${outcome.summary}`,
      })
    }
  }

  let task = event.cardId
  let question: string | undefined
  let answer: string | undefined
  let ownerAnswered = ownerActor({ actor: event.actor })

  if (event.type === 'card.replied' && event.data.state === 'queued' && event.data.decision) {
    if (card?.replies?.some(reply => reply.id === event.data.reply)) {
      return
    }

    question = event.data.answers
    answer = event.data.decision?.answer
    const source = event.data.decision.fromMessage

    const ownerMessage = source && state.hydraMessages?.some(message => message.id === source.id
      && ownerActor({ actor: message.actor }))

    if (ownerMessage) {
      ownerAnswered = true
    }
  } else if (event.type === 'hydra.message' && event.data.task) {
    task = event.data.task
    question = event.data.answers
    answer = event.data.text
  } else if (event.type === 'task.released') {
    question = event.data.answers
    answer = event.data.message.text
  }

  const target = state.cards[task]
  const ask = target?.asks?.find(ask => ask.id === question && !ask.answered)

  if (!ownerAnswered || task === HYDRA_CARD || !target || !ask || answer === undefined) {
    return
  }

  answered({
    title: target.title,
    question: askWording({ ask }).question,
    answer,
  })
}

export function contextNoteBlock({ notes }: { notes: ContextNote[] }): string {
  if (!notes.length) {
    return ''
  }

  const text = notes.map(note => `- ${note.text.replace(
    /</g,
    '&lt;',
  )}`).join('\n')

  return `<pnyx-context>Since your last turn (context only; these facts need no action or reply):\n${text}\n</pnyx-context>`
}

import type { HydraEvent, HydraState } from '#app/model.ts'
import { askWording } from '#tasks/ask-state.ts'
import { ownerActor, reportActor } from '#app/actors.ts'
import { needsMain } from '#routine-helper/state.ts'
import { HYDRA_CARD } from './identity.ts'
import { historyCommand } from './history-command.ts'

const CONTEXT_NOTE_LIMIT = 20
const CONTEXT_TURN_LINES = 8
export const CONTEXT_NOTE_CHARS = 400
const QUESTION_CHARS = 90
const ANSWER_CHARS = 180

export interface ContextNote {
  id: string
  seq: number
  text: string
  task?: string
  ownerAnswer?: boolean
  report?: boolean
  handled?: boolean
  progress?: number
}

// Older snapshots recorded owner answers without metadata.
const isOwnerAnswer = ({ note }: { note: ContextNote }) => note.ownerAnswer === true
  || note.text.startsWith('Owner answered ')

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
    const delivered = event.data.ids
    state.contextNotes = (state.contextNotes ?? []).filter(note => delivered
      ? !delivered.includes(note.id)
      : note.seq > event.data.through)

    return
  }

  const add = ({
    id = event.id,
    text,
    task = event.cardId,
    ownerAnswer = false,
    report = false,
    progress = false,
  }: {
    id?: string
    text: string
    task?: string
    ownerAnswer?: boolean
    report?: boolean
    progress?: boolean
  }) => {
    const notes = state.contextNotes ?? []

    if (notes.some(note => note.id === id)) {
      return
    }

    const previousProgress = notes.filter(note => note.task === task && note.progress)
    const retained = notes.filter(note => {
      if (progress && note.task === task && note.progress) {
        return false
      }

      return report || ownerAnswer || note.report || isOwnerAnswer({ note }) || note.task !== task
    })
    const next: ContextNote = {
      id,
      seq: event.seq,
      text: line({ text }),
      task,
    }

    if (ownerAnswer) {
      next.ownerAnswer = true
    }

    if (report) {
      next.report = true
    }

    if (progress) {
      next.progress = 1 + previousProgress.reduce(
        (
          count,
          note,
        ) => count + (note.progress ?? 0),
        0,
      )
    }

    const pending = [
      ...retained,
      next,
    ]
    const routine = pending.filter(note => !note.report && !isOwnerAnswer({ note }))
      .slice(-CONTEXT_NOTE_LIMIT)
    state.contextNotes = pending.filter(note => note.report || isOwnerAnswer({ note })
      || routine.includes(note))
  }

  if (reportActor({ actor: event.actor })) {
    if (event.type === 'hydra.message') {
      add({
        task: event.data.task,
        text: event.data.text,
        report: true,
        progress: event.data.kind === 'progress',
      })
    } else if (event.type === 'task.declared') {
      add({
        text: `declared ${event.data.state}: ${event.data.note ?? ''}`,
        report: true,
      })
    } else if (event.type === 'task.report') {
      add({
        text: `result: ${event.data.text}`,
        report: true,
      })
    }
  }

  const answered = ({
    id,
    task = event.cardId,
    title,
    question,
    answer,
  }: {
    id?: string
    task?: string
    title: string
    question: string
    answer: string
  }) => add({
    id,
    task,
    ownerAnswer: true,
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

  if (event.type === 'hydra.helper-finished') {
    const batch = state.helper?.runs[event.data.batch]

    for (const note of state.contextNotes ?? []) {
      if (!note.report || !batch?.seqs.includes(note.seq)) {
        continue
      }

      const outcome = event.data.outcomes.find(outcome => outcome.task === note.task)
      note.handled = !event.data.error && outcome !== undefined && !needsMain({ outcome })
    }
  }

  if (event.type === 'hydra.helper-finished' && !event.data.error) {
    for (const outcome of event.data.outcomes) {
      if (needsMain({ outcome }) || outcome.status === 'still_waiting') {
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
        task: outcome.task,
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
    task,
    title: target.title,
    question: askWording({ ask }).question,
    answer,
  })
}

export function contextTurnNotes({ notes }: { notes: ContextNote[] }): ContextNote[] {
  const limit = notes.length > CONTEXT_TURN_LINES ? CONTEXT_TURN_LINES - 1 : CONTEXT_TURN_LINES

  return notes.slice(
    0,
    limit,
  )
}

export function contextNoteBlock({
  notes,
  hydraId,
  state,
}: {
  notes: ContextNote[]
  hydraId: string
  state: HydraState
}): string {
  if (!notes.length) {
    return ''
  }

  const shown = contextTurnNotes({ notes })
  const lines = shown.map(note => {
    const text = note.text.replace(
      /</g,
      '&lt;',
    )

    if (!note.report) {
      return `- ${text}`
    }

    const handled = note.handled === true
    const leased = Object.values(state.helper?.runs ?? {}).some(batch =>
      !batch.error && batch.seqs.includes(note.seq))
    let status = 'unhandled'

    if (handled) {
      status = 'handled'
    } else if (leased) {
      status = 'helper handling'
    }

    let count = ''

    if (note.progress) {
      count = ' (progress)'

      if (note.progress > 1) {
        count = ` (${note.progress} progress reports, latest)`
      }
    }

    return `- seq ${note.seq} ${note.task ?? 'no task'} [${status}]${count}: ${text}`
  })
  const omitted = notes.slice(shown.length)
  const reports = omitted.filter(note => note.report)
  const firstReport = reports[0]

  if (firstReport) {
    lines.push(`- ${reports.length} more worker reports; read \`pnyx-axi hydra check --after ${firstReport.seq - 1} --hydra ${hydraId}\` for the rest.`)
  }

  const otherNotes = omitted.length - reports.length

  if (otherNotes) {
    lines.push(`- ${otherNotes} more context notes; read \`${historyCommand({
      hydraId,
      since: 'origin',
      through: omitted.at(-1)!.seq,
    })}\` for the rest.`)
  }

  return `<pnyx-context>Since your last turn. Worker reports marked handled were already handled by the routine helper; do not act twice. Other notes are context only. Full report bodies remain in task history or hydra messages; each report names its event seq.\n${lines.join('\n')}\n</pnyx-context>`
}

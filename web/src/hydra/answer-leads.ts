import type { HydraState } from '#app/model.ts'
import { ownerActor } from '#app/actors.ts'
import { askWording } from '#tasks/ask-state.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'

export interface AnswerLead {
  task: string
  question: string
  options: string[]
  choice?: string
  recommended?: number
  discussion: boolean
}

export function answerLeads({
  messages = [],
  cards,
  previous,
}: {
  messages?: HydraState['hydraMessages']
  cards: HydraState['cards']
  previous?: ReadonlyMap<string, AnswerLead>
}): Map<string, AnswerLead> {
  return new Map(messages.flatMap(message => {
    const discussion = !message.answers
    const askId = discussion ? message.discusses : message.answers
    const task = message.task

    if (!askId || !task || task === HYDRA_CARD || !ownerActor({ actor: message.actor })) {
      return []
    }

    const ask = cards[task]?.asks?.find(ask => ask.id === askId)

    if (!ask) {
      return []
    }

    const lead: AnswerLead = {
      task,
      question: askWording({ ask }).question,
      options: (ask.options ?? []).map(option => option.label),
      choice: message.choice,
      recommended: ask.recommended,
      discussion,
    }

    const before = previous?.get(message.id)
    const unchanged = before && before.task === lead.task && before.question === lead.question
      && before.choice === lead.choice && before.recommended === lead.recommended
      && before.discussion === lead.discussion && before.options.length === lead.options.length
      && lead.options.every((
        option,
        index,
      ) => option === before.options[index])

    return [
      [
        message.id,
        unchanged ? before : lead,
      ],
    ]
  }))
}

// The opening paragraph, so a folded question renders only what it shows.
export function questionPreview({ question }: { question: string }): string | undefined {
  const [first] = question.trim().split(/\n\s*\n/)

  return first === question.trim() ? undefined : first
}

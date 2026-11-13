import type { HydraState } from '#app/model.ts'
import type { ThreadEntry } from '#hydra/transcripts-read.ts'
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

// Entries carry answers or discusses only for the owner's own messages.
export function answerLeads({
  entries = [],
  cards,
  previous,
}: {
  entries?: ThreadEntry[]
  cards: HydraState['cards']
  previous?: ReadonlyMap<string, AnswerLead>
}): Map<string, AnswerLead> {
  return new Map(entries.flatMap(entry => {
    const discussion = !entry.answers
    const askId = discussion ? entry.discusses : entry.answers
    const {
      task,
      reference,
    } = entry

    if (!askId || !task || !reference || task === HYDRA_CARD) {
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
      choice: entry.choice,
      recommended: ask.recommended,
      discussion,
    }

    const before = previous?.get(reference)
    const unchanged = before && before.task === lead.task && before.question === lead.question
      && before.choice === lead.choice && before.recommended === lead.recommended
      && before.discussion === lead.discussion && before.options.length === lead.options.length
      && lead.options.every((
        option,
        index,
      ) => option === before.options[index])

    return [
      [
        reference,
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

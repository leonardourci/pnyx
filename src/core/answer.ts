// Inline answers to an agent's own prompt: which open requests the board can answer,
// the choices each one offers, and the check of an answer before anything is typed.
// Pure; the keys each harness expects are in integrations/hooks/answer.ts.
import type { Attention, Card } from './model.ts'

// One question's answer: the 1-based numbers of the options picked, or free text
// typed into the prompt's own "Type something" line (single-choice questions only).
export type QuestionAnswer = { pick: number[] } | { text: string }

export const CHOICES = ['allow', 'deny', 'approve', 'revise'] as const
export type ChoiceName = (typeof CHOICES)[number]

// A question request takes answers, one per question; a permission or plan request
// takes a choice, with text where the choice asks for it.
export interface Answer {
  answers?: QuestionAnswer[]
  choice?: ChoiceName
  text?: string
}

export interface Choice {
  choice: ChoiceName
  label: string
  text: 'none' | 'optional' | 'required'
}

export type Prompt = { kind: 'questions' } | { kind: 'choices'; choices: Choice[] }
type Checked = { answer: Answer } | { error: string }

// Free text goes into a one-line field of the agent's prompt.
const TEXT_MAX = 2000
const TOOL_REQUEST = 'hook:tool:'

const CLAUDE_PERMISSION: Choice[] = [
  { choice: 'allow', label: 'Yes', text: 'none' },
  { choice: 'deny', label: 'No', text: 'optional' },
]
const CLAUDE_PLAN: Choice[] = [
  { choice: 'approve', label: 'Approve, and approve edits manually', text: 'none' },
  { choice: 'revise', label: 'Keep planning', text: 'required' },
]
const CODEX_PERMISSION: Choice[] = [
  { choice: 'allow', label: 'Yes, proceed', text: 'none' },
  { choice: 'deny', label: 'No', text: 'optional' },
]

// The prompt behind an open request, or undefined when only the terminal can answer
// it: a request another source opened, one already answered, a notification that
// does not say which prompt is showing, or a harness whose keys were not verified.
export function answerPrompt(
  { card, request }: { card: Card; request: Attention },
): Prompt | undefined {
  if (request.answered || !request.key.startsWith(TOOL_REQUEST)) {
    return undefined
  }

  const provider = card.agent?.provider

  if (provider === 'claude-code') {
    if (request.kind === 'question') {
      return request.questions?.length ? { kind: 'questions' } : undefined
    }

    if (request.kind === 'plan') {
      return { kind: 'choices', choices: CLAUDE_PLAN }
    }

    return request.kind === 'permission' ? { kind: 'choices', choices: CLAUDE_PERMISSION } : undefined
  }

  return provider === 'codex' && request.kind === 'permission' ? { kind: 'choices', choices: CODEX_PERMISSION } : undefined
}

function line({ value }: { value: unknown }): string | undefined {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() || undefined : undefined
}

function record({ value }: { value: unknown }): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function checkQuestions({ request, value }: { request: Attention; value: unknown }): Checked {
  const questions = request.questions ?? []

  if (!Array.isArray(value) || value.length !== questions.length) {
    return { error: `answers must be a list with one answer for each of the ${questions.length} questions` }
  }

  const answers: QuestionAnswer[] = []

  for (const [i, question] of questions.entries()) {
    const item = record({ value: value[i] })
    const at = `answers[${i}]`

    if (!item) {
      return { error: `${at} must be {"pick":[n,...]} or {"text":"..."}` }
    }

    if ('text' in item) {
      const text = line({ value: item.text })

      if (question.multiSelect) {
        return { error: `${at}: "${question.question}" takes several options, so pick from them` }
      }

      if (!text || text.length > TEXT_MAX) {
        return { error: `${at}.text must be 1 to ${TEXT_MAX} characters` }
      }

      answers.push({ text })
      continue
    }

    const pick = item.pick
    const count = question.options.length

    if (
      !Array.isArray(pick)
      || pick.length === 0
      || !pick.every(n => Number.isInteger(n) && n >= 1 && n <= count)
      || new Set(pick).size !== pick.length
    ) {
      return { error: `${at}.pick must list option numbers from 1 to ${count}, each once` }
    }

    if (!question.multiSelect && pick.length !== 1) {
      return { error: `${at}: "${question.question}" takes one option` }
    }

    answers.push({ pick: [...pick].sort((a, b) => a - b) })
  }

  return { answer: { answers } }
}

// The answer in its checked, normalized form, or why it does not fit the prompt.
export function checkAnswer(
  { prompt, request, value: raw }: { prompt: Prompt; request: Attention; value: unknown },
): Checked {
  const value = record({ value: raw })

  if (!value) {
    return { error: 'the answer must be a JSON object' }
  }

  if (prompt.kind === 'questions') {
    return checkQuestions({ request, value: value.answers })
  }

  const choice = prompt.choices.find(c => c.choice === value.choice)

  if (!choice) {
    return { error: `choice must be one of ${prompt.choices.map(c => c.choice).join(', ')}` }
  }

  const text = line({ value: value.text })

  if (choice.text === 'none' && text) {
    return { error: `${choice.choice} takes no text` }
  }

  if (choice.text === 'required' && !text) {
    return { error: `${choice.choice} needs text saying what to change` }
  }

  if (text && text.length > TEXT_MAX) {
    return { error: `text must be at most ${TEXT_MAX} characters` }
  }

  return { answer: { choice: choice.choice, ...(text ? { text } : {}) } }
}

// The answer in words, kept on its reply receipt: "Pick a color → Blue".
export function answerText(
  { prompt, request, answer }: { prompt: Prompt; request: Attention; answer: Answer },
): string {
  if (prompt.kind === 'questions') {
    return (request.questions ?? []).map((question, i) => {
      const a = answer.answers?.[i]
      const said = !a ? '' : 'text' in a ? a.text : a.pick.map(n => question.options[n - 1]?.label).join(', ')

      return `${question.question} → ${said}`
    })
      .join('\n')
  }

  const label = prompt.choices.find(c => c.choice === answer.choice)?.label ?? answer.choice ?? ''

  return answer.text ? `${label}: ${answer.text}` : label
}

import type { Card } from '../tasks/model.ts'
import type { Attention, FormField } from './model.ts'
import { replyRoute } from './route.ts'

// One question's answer: the 1-based numbers of the options picked, or free text
// typed into the prompt's own "Type something" line (single-choice questions only).
export type QuestionAnswer = { pick: number[] } | { text: string }

export const CHOICES = [
  'allow',
  'deny',
  'approve',
  'revise',
  'accept',
  'decline',
] as const
export type ChoiceName = (typeof CHOICES)[number]

export type FieldValue = string | number | boolean

export interface Answer {
  answers?: QuestionAnswer[]
  choice?: ChoiceName
  text?: string
  values?: Record<string, FieldValue>
}

export interface Choice {
  choice: ChoiceName
  label: string
  text: 'none' | 'optional' | 'required'
}

export type Prompt = { kind: 'questions' } | { kind: 'form' } | {
  kind: 'choices'
  choices: Choice[]
}
type Checked = { answer: Answer } | { error: string }

// Free text goes into a one-line field of the agent's prompt.
const TEXT_MAX = 2000
const TOOL_REQUEST = 'hook:tool:'
const ELICITATION = 'hook:elicitation'

const CLAUDE_PERMISSION: Choice[] = [
  {
    choice: 'allow',
    label: 'Yes',
    text: 'none',
  },
  {
    choice: 'deny',
    label: 'No',
    text: 'optional',
  },
]
const CLAUDE_PLAN: Choice[] = [
  {
    choice: 'approve',
    label: 'Approve, and approve edits manually',
    text: 'none',
  },
  {
    choice: 'revise',
    label: 'Keep planning',
    text: 'required',
  },
]
const CODEX_PERMISSION: Choice[] = [
  {
    choice: 'allow',
    label: 'Yes, proceed',
    text: 'none',
  },
  {
    choice: 'deny',
    label: 'No',
    text: 'optional',
  },
]

// A question's options are picked by digit, and a form's choices are each a Down key
// away, so longer lists are left to the terminal.
export const MAX_OPTIONS = 8

// Names one request exactly as it was shown, so an answer lands only on the prompt
// it was written for: a later request under the same key with other text,
// questions or fields is a different prompt. FNV-1a over its fields, so the browser
// and the CLI name it alike.
export function requestId({ request }: { request: Attention }): string {
  const {
    kind,
    key,
    text,
    questions,
    form,
  } = request
  const shown = JSON.stringify({
    kind,
    key,
    text,
    questions,
    form,
  })
  let hash = 0x811c9dc5

  for (let i = 0; i < shown.length; i++) {
    hash = Math.imul(
      hash ^ shown.charCodeAt(i),
      0x01000193,
    )
  }

  return `${key}#${(hash >>> 0).toString(16).padStart(
    8,
    '0',
  )}`
}

// Whether the card's recorded route can press the keys: only a tmux pane, the one
// host whose keys were checked by hand against each harness's prompt.
function takesKeys({ card }: { card: Card }): boolean {
  const found = replyRoute({
    card,
    homes: [],
  })

  return 'route' in found && found.route.kind === 'tmux'
}

// The prompt behind an open request, or undefined when only the terminal can answer
// it: a request another source opened, one already answered, a notification that
// does not say which prompt is showing, a harness whose keys were not verified, or
// a card whose route cannot press keys.
export function answerPrompt(
  {
    card,
    request,
  }: {
    card: Card
    request: Attention
  },
): Prompt | undefined {
  if (request.answered || !takesKeys({ card })) {
    return undefined
  }

  const provider = card.agent?.provider

  if (request.key === ELICITATION && request.form?.length && provider === 'claude-code') {
    return { kind: 'form' }
  }

  if (!request.key.startsWith(TOOL_REQUEST)) {
    return undefined
  }

  if (provider === 'claude-code') {
    if (request.kind === 'question') {
      const fits = request.questions?.length
        && request.questions.every(q => q.options.length <= MAX_OPTIONS)

      return fits ? { kind: 'questions' } : undefined
    }

    if (request.kind === 'plan') {
      return {
        kind: 'choices',
        choices: CLAUDE_PLAN,
      }
    }

    return request.kind === 'permission' ? {
      kind: 'choices',
      choices: CLAUDE_PERMISSION,
    } : undefined
  }

  return provider === 'codex' && request.kind === 'permission' ? {
    kind: 'choices',
    choices: CODEX_PERMISSION,
  } : undefined
}

// One line of text to type into a prompt. A control character would be typed as a
// key (Ctrl-C, Escape, an arrow), so text holding one is refused.
function line({ value }: { value: unknown }): string | undefined {
  const text = typeof value === 'string' ? value.replace(
    /[ \t\r\n]+/g,
    ' ',
  ).trim() : ''

  // eslint-disable-next-line no-control-regex
  return text && !/[\u0000-\u001f\u007f-\u009f]/.test(text) ? text : undefined
}

function record({ value }: { value: unknown }): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function checkQuestions({
  request,
  value,
}: {
  request: Attention
  value: unknown
}): Checked {
  const questions = request.questions ?? []

  if (!Array.isArray(value) || value.length !== questions.length) {
    return { error: `answers must be a list with one answer for each of the ${questions.length} questions` }
  }

  const answers: QuestionAnswer[] = []

  for (const [
    i,
    question,
  ] of questions.entries()) {
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

    answers.push({
      pick: [...pick].sort((
        a,
        b,
      ) => a - b),
    })
  }

  return { answer: { answers } }
}

type Field = {
  field: FormField
  value: unknown
}

function fieldValue({
  field,
  value,
}: Field): { value: FieldValue } | { error: string } {
  const name = field.title ?? field.name

  if (field.type === 'boolean') {
    return typeof value === 'boolean' ? { value } : { error: `${name} must be true or false` }
  }

  if (field.type !== 'string') {
    const ok = typeof value === 'number' && Number.isFinite(value) && (field.type === 'number' || Number.isInteger(value))

    return ok ? { value } : { error: `${name} must be ${field.type === 'integer' ? 'a whole number' : 'a number'}` }
  }

  const text = line({ value })

  if (!text || text.length > TEXT_MAX) {
    return { error: `${name} must be 1 to ${TEXT_MAX} characters` }
  }

  return !field.options || field.options.includes(text) ? { value: text } : { error: `${name} must be one of ${field.options.join(', ')}` }
}

type Form = {
  fields: FormField[]
  value: Record<string, unknown>
}

function checkForm({
  fields,
  value,
}: Form): Checked {
  if (value.choice === 'decline') {
    return { answer: { choice: 'decline' } }
  }

  const given = record({ value: value.values })

  if (value.choice !== 'accept' || !given) {
    return { error: 'a form takes {"choice":"accept","values":{...}} or {"choice":"decline"}' }
  }

  const unknown = Object.keys(given).filter(k => !fields.some(f => f.name === k))

  if (unknown.length) {
    return { error: `the form has no field ${unknown.join(', ')}` }
  }

  const values: Record<string, FieldValue> = {}

  for (const field of fields) {
    if (given[field.name] === undefined || given[field.name] === '') {
      if (field.required) {
        return { error: `${field.title ?? field.name} is required` }
      }

      continue
    }

    const checked = fieldValue({
      field,
      value: given[field.name],
    })

    if ('error' in checked) {
      return checked
    }

    values[field.name] = checked.value
  }

  return {
    answer: {
      choice: 'accept',
      values,
    },
  }
}

export function checkAnswer(
  {
    prompt,
    request,
    value: raw,
  }: {
    prompt: Prompt
    request: Attention
    value: unknown
  },
): Checked {
  const value = record({ value: raw })

  if (!value) {
    return { error: 'the answer must be a JSON object' }
  }

  if (prompt.kind === 'questions') {
    return checkQuestions({
      request,
      value: value.answers,
    })
  }

  if (prompt.kind === 'form') {
    return checkForm({
      fields: request.form ?? [],
      value,
    })
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

  return {
    answer: {
      choice: choice.choice,
      ...(text ? { text } : {}),
    },
  }
}

export function answerText(
  {
    prompt,
    request,
    answer,
    includeQuestion = true,
  }: {
    prompt: Prompt
    request: Attention
    answer: Answer
    includeQuestion?: boolean
  },
): string {
  if (prompt.kind === 'form') {
    if (answer.choice === 'decline') {
      return 'Decline'
    }

    const said = (request.form ?? []).flatMap(f => {
      const v = answer.values?.[f.name]

      return v === undefined ? [] : [`${f.title ?? f.name}: ${typeof v === 'boolean' ? (v ? 'yes' : 'no') : v}`]
    })

    return [
      'Accept',
      ...said,
    ].join('\n')
  }

  if (prompt.kind === 'questions') {
    return (request.questions ?? []).map((
      question,
      i,
    ) => {
      const a = answer.answers?.[i]
      const said = !a ? '' : 'text' in a ? a.text : a.pick.map(n => question.options[n - 1]?.label).join(', ')

      return includeQuestion ? `${question.question} → ${said}` : said
    })
      .join('\n')
  }

  const label = prompt.choices.find(c => c.choice === answer.choice)?.label ?? answer.choice ?? ''

  return answer.text ? `${label}: ${answer.text}` : label
}

// The keys each harness's own prompt expects for an inline answer, checked by hand
// against scratch sessions of Claude Code 2.1.299 and Codex 0.160.1 in tmux. Each
// entry is typed as keystrokes, never pasted, with a short settle after it.
import type { Answer } from '../../core/answer.ts'
import type { Attention } from '../../core/model.ts'

export const KEY = {
  enter: '\r',
  escape: '\u001b',
  tab: '\t',
  up: '\u001b[A',
  down: '\u001b[B',
  right: '\u001b[C',
  space: ' ',
}

// One keystroke chunk and how long the prompt needs before the next one.
export interface KeyStep {
  keys: string
  settleMs: number
}

const SETTLE_MS = 400
// Codex leaves its approval prompt and redraws the composer after Escape.
const REDRAW_MS = 1200

function steps({ keys }: { keys: string[] }): KeyStep[] {
  return keys.map(k => ({ keys: k, settleMs: SETTLE_MS }))
}

// Claude Code's AskUserQuestion: a number picks a single-choice option and moves on,
// and its last line, "Type something.", takes typed text and Enter; in a
// multiple-choice question numbers toggle options and Right moves on. Several
// questions, or a multiple-choice one, end on a review whose option 1 submits.
function claudeQuestions({ request, answer }: { request: Attention; answer: Answer }): KeyStep[] {
  const questions = request.questions ?? []
  const keys = questions.flatMap((question, i) => {
    const a = answer.answers?.[i]

    if (!a) {
      return []
    }

    if ('text' in a) {
      return [String(question.options.length + 1), a.text, KEY.enter]
    }

    const picks = a.pick.map(String)

    return question.multiSelect ? [...picks, KEY.right] : picks
  })
  const review = questions.length > 1 || questions.some(q => q.multiSelect)

  return steps({ keys: [...keys, ...(review ? ['1'] : [])] })
}

// Claude Code's MCP form starts on its first field, in schema order, then Accept
// and Decline. Typing fills a text or number field; Right opens a choice field,
// whose options Down walks and Space picks; Space ticks a box; Down moves to the
// next field. Enter on Accept sends the form; Right from Accept is Decline.
function claudeForm({ request, answer }: { request: Attention; answer: Answer }): KeyStep[] {
  const fields = request.form ?? []

  if (answer.choice === 'decline') {
    return steps({ keys: [...fields.map(() => KEY.down), KEY.right, KEY.enter] })
  }

  const keys = fields.flatMap(field => {
    const value = answer.values?.[field.name]
    const index = Math.max(0, field.options?.indexOf(String(value)) ?? 0)
    const below = Array<string>(index).fill(KEY.down)
    const fill = value === undefined || value === false
      ? []
      : field.options
        ? [KEY.right, ...below, KEY.space]
        : [value === true ? KEY.space : String(value)]

    return [...fill, KEY.down]
  })

  return steps({ keys: [...keys, KEY.enter] })
}

// The keystrokes that answer request in the session's own prompt.
export function answerKeys(
  { provider, request, answer }: { provider: string; request: Attention; answer: Answer },
): KeyStep[] {
  if (provider === 'codex') {
    // Codex: y runs the command; Escape refuses it and ends the turn, so text that
    // says what to do instead is then sent as the next prompt.
    if (answer.choice === 'allow') {
      return steps({ keys: ['y'] })
    }

    return answer.text
      ? [{ keys: KEY.escape, settleMs: REDRAW_MS }, ...steps({ keys: [answer.text, KEY.enter] })]
      : steps({ keys: [KEY.escape] })
  }

  if (request.kind === 'question') {
    return claudeQuestions({ request, answer })
  }

  if (request.form) {
    return claudeForm({ request, answer })
  }

  switch (answer.choice) {
    // Claude Code's plan prompt: 1 approves in its most permissive mode, 2 approves
    // with edits approved by hand, 3 is a line saying what to change instead.
    case 'approve': return steps({ keys: ['2'] })
    case 'revise': return steps({ keys: ['3', answer.text ?? '', KEY.enter] })
    // Its permission prompt: 1 is Yes and No is the last option, so Up from the
    // first reaches it and Tab opens its line for what to do instead. Escape is a
    // plain No.
    case 'allow': return steps({ keys: ['1'] })
    default: return steps({
      keys: answer.text ? [KEY.up, KEY.tab, answer.text, KEY.enter] : [KEY.escape],
    })
  }
}

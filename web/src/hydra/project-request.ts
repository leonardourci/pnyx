import { reference } from '#hydra/mentions.ts'
import { displayAt } from './draft.ts'

// Add project asks Hydra in the composer: the @ opens the project and folder picker, and the goal is an optional blank.
export const GOAL_SLOT = reference({
  kind: 'slot',
  value: 'goal',
  label: 'what you want done',
})
const REQUEST_HEAD = 'Add @'
const PROJECT_REQUEST = `${REQUEST_HEAD} to this Hydra and ${GOAL_SLOT}.`
const UNPICKED = /(?:^|\n)Add @ to this Hydra\b/

export const GOALS = [
  'look around and tell me what it is',
  'fix the failing tests',
  'pick up its open issues',
  'review its open pull requests',
]

// The request goes on its own line under any draft, with the caret right after its @.
export function withProjectRequest({ text }: { text: string }): {
  text: string
  caret: number
} {
  const draft = text.trimEnd()
  const next = draft ? `${draft}\n${PROJECT_REQUEST}` : PROJECT_REQUEST

  return {
    text: next,
    caret: displayAt({
      text: next,
      offset: next.lastIndexOf(REQUEST_HEAD) + REQUEST_HEAD.length,
    }),
  }
}

// An unfilled goal leaves the message; an @ with no project picked keeps it from going out.
export function sendableRequest({ text }: { text: string }): {
  text: string
  unpicked: boolean
} {
  return {
    text: text.replaceAll(
      ` and ${GOAL_SLOT}`,
      '',
    ).replaceAll(
      GOAL_SLOT,
      '',
    ),
    unpicked: UNPICKED.test(text),
  }
}

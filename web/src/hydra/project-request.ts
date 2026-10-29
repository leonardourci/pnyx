import { reference } from '#hydra/mentions.ts'
import { displayAt } from './draft.ts'
import type { MentionItem } from './mention-picker.tsx'

// Add project asks Hydra in the composer: the @ opens the project and folder picker, and the goal is an optional blank.
export const GOAL_SLOT = reference({
  kind: 'slot',
  value: 'goal',
  label: 'what you want done',
})
export const REQUEST_HEAD = 'Add '
const REQUEST_START = `${REQUEST_HEAD}@`
const PROJECT_REQUEST = `${REQUEST_START} to this Hydra and ${GOAL_SLOT}.`
const UNPICKED = /(?:^|\n)Add @ to this Hydra\b/

// The path in an Add project request, which shows as a badge while staying plain text.
const REQUEST_PATH = /(^|\n)Add ([^\s@](?:(?! to this Hydra)[^\n])*) to this Hydra/g

// In an Add project request a project goes in as its plain path, so the caret moves through it like text.
export const mentionText = ({
  item,
  before,
}: {
  item: MentionItem
  before: string
}) => before.endsWith(REQUEST_HEAD) && item.path ? item.path : item.insert

export function requestPaths({ display }: { display: string }) {
  const matches = [...display.matchAll(REQUEST_PATH)]

  // Both groups always take part in a match.
  return matches.map(match => {
    const from = match.index + match[1]!.length + REQUEST_HEAD.length

    return {
      from,
      to: from + match[2]!.length,
    }
  })
}

export const GOALS = [
  'look around and tell me what it is',
  'fix the failing tests',
  'pick up its open issues',
  'review its open pull requests',
] as const

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
      offset: next.lastIndexOf(REQUEST_START) + REQUEST_START.length,
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

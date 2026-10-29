import { KEY_ACTIONS, type KeyScope } from '#preferences/keyboard.ts'

// Settings lists each action under where it works.
const GROUPS: Record<KeyScope, string> = {
  hydra: 'Board',
  thread: 'Conversation',
  composer: 'Composer',
  navigation: 'Everywhere',
  overlay: 'Everywhere',
  hints: 'Everywhere',
}

type KeyAction = (typeof KEY_ACTIONS)[number]

export const groupOf = ({ action }: { action: KeyAction }) =>
  action.scopes.length > 1 ? 'Everywhere' : GROUPS[action.scopes[0]!]

// The actions whose name, group or default keys contain every query word.
export const keyActionsMatching = ({ query }: { query: string }) => {
  const asked = query.toLowerCase().split(/\s+/)
    .filter(Boolean)

  return KEY_ACTIONS.filter(action => {
    const text = [
      action.label,
      groupOf({ action }),
      ...action.keys,
    ].join(' ').toLowerCase()

    return asked.every(word => text.includes(word))
  })
}

import type { HydraState } from '#app/model.ts'
import { hydraConfig } from './config.ts'
import type { HydraMessage } from './model.ts'

// How many of Hydra's messages one page of an unbounded conversation shows.
export const MESSAGE_PAGE = 20

// `m` and the id of the oldest message a page shows, URL-encoded: the next read shows the messages before it.
export const MESSAGE_CURSOR = /^m([\w%.!~*'()-]+)$/

export interface MessageWindow {
  // The time of the oldest message the page shows; the conversation holds nothing older until the next read.
  messagesFrom?: string
  older?: string
}

export const hydraMessagesOf = ({ state }: { state: HydraState }): HydraMessage[] => {
  const hydra = hydraConfig({ state }).hydra.id

  return (state.hydraMessages ?? []).filter(message => message.hydra === hydra)
}

// The newest page of Hydra's messages, or the page before the message `before` names. A conversation whose messages
// all fit the page has no window, and a cursor naming no message ends the history.
export function messageWindow({
  messages,
  before,
}: {
  messages: HydraMessage[]
  before?: string
}): MessageWindow {
  const index = before === undefined
    ? messages.length
    : messages.findIndex(message => message.id === before)

  if (index < 0 || (before === undefined && messages.length <= MESSAGE_PAGE)) {
    return {}
  }

  const start = Math.max(
    0,
    index - MESSAGE_PAGE,
  )
  const first = messages[start]

  return {
    ...first ? { messagesFrom: first.at } : {},
    ...start > 0 ? { older: `m${encodeURIComponent(first!.id)}` } : {},
  }
}

export interface AskTarget {
  id: string
  name: string
  icon: string
}

interface AskStart {
  target?: AskTarget
  request: string
}

const ASK = /^ask(?::(\S+))?\s/i

// "ask " opens a request whose Titan is picked later; "ask:<name> " names the Titan, and an unknown name stays a search.
export function askStart({
  query,
  hydras,
}: {
  query: string
  hydras: AskTarget[]
}): AskStart | null {
  const match = ASK.exec(query)

  if (!match) {
    return null
  }

  const request = query.slice(match[0].length)
  const name = match[1]?.toLowerCase()

  if (name === undefined) {
    return { request }
  }

  const target = hydras.find(hydra => hydra.name.toLowerCase() === name)

  return target ? {
    target,
    request,
  } : null
}

// The current Titan leads even before the Titan list has loaded.
export const askTargets = ({
  hydras,
  current,
}: {
  hydras: AskTarget[]
  current: AskTarget
}) => [
  current,
  ...hydras.filter(hydra => hydra.id !== current.id),
]

export type AskKey = 'send' | 'send-open' | 'pick' | 'up' | 'down' | 'back' | 'leave'

export function askKey({
  key,
  mod = false,
  composing,
  picking,
  targeted,
  request,
}: {
  key: string
  mod?: boolean
  composing: boolean
  // The Titan list is showing.
  picking: boolean
  targeted: boolean
  request: string
}): AskKey | null {
  if (composing) {
    return null
  }

  if (key === 'Escape') {
    return picking ? 'back' : 'leave'
  }

  if (picking && (key === 'ArrowDown' || key === 'ArrowUp')) {
    return key === 'ArrowDown' ? 'down' : 'up'
  }

  if (key !== 'Enter' || !request.trim()) {
    return null
  }

  if (!picking && !targeted) {
    return 'pick'
  }

  return mod ? 'send-open' : 'send'
}

export interface AskAttempt {
  // Othrys records an event id once, so a retry with the same id replays the first receipt.
  id: string
  text: string
  to: string
}

// A retry of the same request to the same Titan keeps its event id, so the Titan gets it once.
export const askAttempt = ({
  kept,
  text,
  to,
}: {
  kept: AskAttempt | null
  text: string
  to: string
}): AskAttempt => kept?.text === text && kept.to === to ? kept : {
  id: crypto.randomUUID(),
  text,
  to,
}

export type SettledSend = 'notify' | 'show-error' | 'close' | 'open-chat'

// A request the owner has left, by closing the palette or leaving Ask mode, only notifies.
export function settledSend({
  current,
  sent,
  opening,
}: {
  current: boolean
  sent: boolean
  opening: boolean
}): SettledSend {
  if (!current) {
    return 'notify'
  }

  if (!sent) {
    return 'show-error'
  }

  return opening ? 'open-chat' : 'close'
}

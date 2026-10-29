export interface AskTarget {
  id: string
  name: string
  icon: string
}

export interface AskStart {
  target?: AskTarget
  request: string
}

const ASK = /^ask(?::(\S+))?\s/i

// "ask " opens a request whose Hydra is picked later; "ask:<name> " names the Hydra, and an unknown name stays a search.
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

// The current Hydra leads even before the Hydra list has loaded.
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

// Hydra reads the place first, so it knows what the request is about.
export const askMessage = ({
  place,
  request,
}: {
  place?: string
  request: string
}) => place ? `About ${place}: ${request.trim()}` : request.trim()

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
  // The Hydra list is showing.
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

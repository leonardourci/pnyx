export interface BriefNote { at?: string; source: string; text: string }

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim()

// Newest first, each text once, leaving out what the conversation already shows.
export function briefNotes({ notes, conversation }: {
  notes: BriefNote[]
  conversation: string[]
}): BriefNote[] {
  const chat = conversation.map(normalize), seen = new Set<string>()

  return [...notes].sort((a, b) => (b.at ?? '').localeCompare(a.at ?? '')).filter(note => {
    const text = normalize(note.text).replace(/^(?:done|resolved)(?: \[[^\]]+\])?:\s*/, '')

    if (!text || seen.has(text) || chat.some(message => message.includes(text))) {
      return false
    }

    seen.add(text)

    return true
  })
}

export function relativeTime({ at, now }: { at: string | undefined; now: number }): string {
  const value = at ? Date.parse(at) : NaN

  if (!Number.isFinite(value)) {
    return 'Time not recorded'
  }

  const seconds = Math.max(0, (now - value) / 1000)

  for (const [unit, size] of [['y', 31536000], ['mo', 2592000], ['d', 86400], ['h', 3600], ['m', 60]] as const) {
    if (seconds >= size) {
      return `${Math.floor(seconds / size)}${unit} ago`
    }
  }

  return 'just now'
}

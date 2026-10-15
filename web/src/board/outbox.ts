export interface MessageAttempt { text: string; id: string; pending: boolean }

export function readAttempt({ key }: { key: string }): MessageAttempt | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(`pnyx-send:${key}`) ?? 'null')

    return value && typeof value.text === 'string' && typeof value.id === 'string' && typeof value.pending === 'boolean' ? value : null
  } catch {
    return null
  }
}

export function saveAttempt({ key, attempt }: {
  key: string
  attempt: MessageAttempt | null
}): void {
  try {
    if (attempt) {
      sessionStorage.setItem(`pnyx-send:${key}`, JSON.stringify(attempt))
    } else {
      sessionStorage.removeItem(`pnyx-send:${key}`)
    }
  } catch { /* The mounted composer still retains the draft when storage is blocked. */ }
}

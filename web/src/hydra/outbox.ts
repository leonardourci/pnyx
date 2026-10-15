export function storageKey({ key }: { key: string }): string {
  const hydraId = typeof document === 'undefined' ? '' : document.querySelector<HTMLMetaElement>('meta[name=pnyx-hydra]')?.content

  return `pnyx:${hydraId ?? ''}:${key}`
}

export interface MessageAttempt { text: string; id: string; pending: boolean }

export function readAttempt({ key }: { key: string }): MessageAttempt | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(storageKey({ key: `send:${key}` })) ?? 'null')

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
      sessionStorage.setItem(storageKey({ key: `send:${key}` }), JSON.stringify(attempt))
    } else {
      sessionStorage.removeItem(storageKey({ key: `send:${key}` }))
    }
  } catch { /* The mounted composer still retains the draft when storage is blocked. */ }
}

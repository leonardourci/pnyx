export function storageKey({
  key,
  hydraId: given,
}: {
  key: string
  hydraId?: string
}): string {
  const hydraId = given ?? (typeof document === 'undefined' ? '' : document.querySelector<HTMLMetaElement>('meta[name=pnyx-hydra]')?.content)

  return `pnyx:${hydraId ?? ''}:${key}`
}

export interface MessageAttempt {
  text: string
  id: string
  pending: boolean
}

export function readAttempt({
  key,
  hydraId,
}: {
  key: string
  hydraId?: string
}): MessageAttempt | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(storageKey({
      key: `send:${key}`,
      hydraId,
    })) ?? 'null')

    return value && typeof value.text === 'string' && typeof value.id === 'string' && typeof value.pending === 'boolean' ? value : null
  } catch {
    return null
  }
}

export function saveAttempt({
  key,
  attempt,
  hydraId,
}: {
  key: string
  attempt: MessageAttempt | null
  hydraId?: string
}): void {
  try {
    if (attempt) {
      sessionStorage.setItem(
        storageKey({
          key: `send:${key}`,
          hydraId,
        }),
        JSON.stringify(attempt),
      )
    } else {
      sessionStorage.removeItem(storageKey({
        key: `send:${key}`,
        hydraId,
      }))
    }
  } catch { /* The mounted composer still retains the draft when storage is blocked. */ }
}

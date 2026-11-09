import type { SaveCommand } from '#app/save-receipts.ts'

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

export function moveHydraStorage({
  storage,
  from,
  to,
}: {
  storage: Storage
  from: string
  to: string
}): void {
  if (from === to) {
    return
  }

  try {
    const prefix = `pnyx:${from}:`

    for (const key of Object.keys(storage).filter(key => key.startsWith(prefix))) {
      const value = storage.getItem(key)
      const target = `pnyx:${to}:${key.slice(prefix.length)}`

      if (value !== null && storage.getItem(target) === null) {
        storage.setItem(
          target,
          value,
        )
      }

      storage.removeItem(key)
    }
  } catch { /* The mounted view still retains drafts when storage is blocked. */ }
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

export function readSettingsSaves({ hydraId }: { hydraId: string }): SaveCommand[] {
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(storageKey({
      key: 'settings-saves',
      hydraId,
    })) ?? '[]')

    if (!Array.isArray(saved)) {
      return []
    }

    return saved.filter((entry): entry is SaveCommand => entry?.type === 'command'
      && entry.name === 'hydra-agent' && typeof entry.id === 'string'
      && Array.isArray(entry.args) && entry.args.length === 1 && typeof entry.args[0] === 'string')
  } catch {
    return []
  }
}

export function saveSettingsSaves({
  hydraId,
  commands,
}: {
  hydraId: string
  commands: SaveCommand[]
}): void {
  try {
    sessionStorage.setItem(
      storageKey({
        key: 'settings-saves',
        hydraId,
      }),
      JSON.stringify(commands),
    )
  } catch { /* The mounted connection retains operation IDs when storage is blocked. */ }
}

// Owner messages the server refused, kept with their reason until a retry sends them.
export interface UnsentMessage {
  id: string
  text: string
  at: string
  failed: string
}

export function readUnsent({ key }: { key: string }): UnsentMessage[] {
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(storageKey({ key: `unsent:${key}` })) ?? '[]')

    return Array.isArray(saved) ? saved.filter((item): item is UnsentMessage => typeof item?.id === 'string'
      && typeof item.text === 'string' && typeof item.at === 'string' && typeof item.failed === 'string') : []
  } catch {
    return []
  }
}

export function saveUnsent({
  key,
  items,
}: {
  key: string
  items: UnsentMessage[]
}): void {
  try {
    if (items.length) {
      sessionStorage.setItem(
        storageKey({ key: `unsent:${key}` }),
        JSON.stringify(items),
      )
    } else {
      sessionStorage.removeItem(storageKey({ key: `unsent:${key}` }))
    }
  } catch { /* The mounted chat still shows unsent messages when storage is blocked. */ }
}

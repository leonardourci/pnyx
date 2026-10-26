import type { SaveCommand } from '../../../src/server/saves.ts'

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

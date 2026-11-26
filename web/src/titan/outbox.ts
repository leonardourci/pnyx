import { saveEventId, type SaveCommand } from '#app/save-receipts.ts'
import { TITAN_CARD } from '#titan/identity.ts'
import { argument } from '#web-tasks/optimistic.ts'

export const TITAN_SEND_SETTLED = 'othrys-hydra-send-settled'

export function storageKey({
  key,
  hydraId: given,
}: {
  key: string
  hydraId?: string
}): string {
  const hydraId = given ?? (typeof document === 'undefined' ? '' : document.querySelector<HTMLMetaElement>('meta[name=othrys-hydra]')?.content)

  return `othrys:${hydraId ?? ''}:${key}`
}

export function moveTitanStorage({
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
    const prefix = `othrys:${from}:`

    for (const key of Object.keys(storage).filter(key => key.startsWith(prefix))) {
      const value = storage.getItem(key)
      const target = `othrys:${to}:${key.slice(prefix.length)}`

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

export function readSavedCommands({ hydraId }: { hydraId: string }): SaveCommand[] {
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(storageKey({
      key: 'settings-saves',
      hydraId,
    })) ?? '[]')

    if (!Array.isArray(saved)) {
      return []
    }

    return saved.filter((entry): entry is SaveCommand => entry?.type === 'command'
      && typeof entry.id === 'string' && !!entry.id
      && Array.isArray(entry.args) && entry.args.every((arg: unknown) => typeof arg === 'string')
      && ((entry.name === 'hydra-agent' && entry.args.length === 1)
        || (entry.name === 'hydra' && entry.args[0] === 'send' && !!saveEventId({command: entry}))))
  } catch {
    return []
  }
}

export function saveCommands({
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

export function readUnsent({
  key,
  hydraId,
}: {
  key: string
  hydraId: string
}): UnsentMessage[] {
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(storageKey({
      key: `unsent:${key}`,
      hydraId,
    })) ?? '[]')

    return Array.isArray(saved) ? saved.filter((item): item is UnsentMessage => typeof item?.id === 'string'
      && typeof item.text === 'string' && typeof item.at === 'string' && typeof item.failed === 'string') : []
  } catch {
    return []
  }
}

export function saveUnsent({
  key,
  hydraId,
  items,
}: {
  key: string
  items: UnsentMessage[]
  hydraId: string
}): void {
  try {
    if (items.length) {
      sessionStorage.setItem(
        storageKey({
          key: `unsent:${key}`,
          hydraId,
        }),
        JSON.stringify(items),
      )
    } else {
      sessionStorage.removeItem(storageKey({
        key: `unsent:${key}`,
        hydraId,
      }))
    }
  } catch { /* The mounted chat still shows unsent messages when storage is blocked. */ }
}

export function settleSavedCommand({
  command,
  hydraId,
  storageIdentity,
  refusal,
}: {
  command: SaveCommand
  hydraId: string
  storageIdentity: string
  refusal?: string
}) {
  if (command.name !== 'hydra' || command.args[0] !== 'send') {
    return
  }

  const id = saveEventId({command})

  if (!id) {
    return
  }

  const attempt = readAttempt({
    key: TITAN_CARD,
    hydraId: storageIdentity,
  })

  if (attempt?.id === id) {
    saveAttempt({
      key: TITAN_CARD,
      hydraId: storageIdentity,
      attempt: null,
    })
  }

  const before = readUnsent({
    key: hydraId,
    hydraId: storageIdentity,
  })
  const items = before.filter(item => item.id !== id)

  if (refusal) {
    items.push({
      id,
      text: argument({
        args: command.args,
        flag: '--text',
      }) ?? '',
      at: before.find(item => item.id === id)?.at ?? new Date().toISOString(),
      failed: refusal,
    })
  }

  saveUnsent({
    key: hydraId,
    hydraId: storageIdentity,
    items,
  })
  dispatchEvent(new CustomEvent(
    TITAN_SEND_SETTLED,
    {
      detail: {
        hydraId,
        id,
        refusal,
      },
    },
  ))
}

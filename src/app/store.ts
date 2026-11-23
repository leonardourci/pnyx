import { nativeTitanIds, readNativeTitan } from './native-read.ts'
import type { TitanState } from './model.ts'
import { nativeHome, openedNativeHome, type NativeHeld } from './native-home.ts'
import { DEFAULT_TITAN } from './home-migration.ts'
import { TitanError } from '#store/errors.ts'
import { log } from './diagnostics.ts'

export interface TitanSnapshot {
  dir: string
  state: TitanState
}

export type Held = NativeHeld

export const heldTitan = ({ hydraId }: { hydraId: string }): Held | undefined => {
  const home = openedNativeHome()

  return home?.held.has(hydraId) ? home.read({ hydra: hydraId }) : undefined
}

export async function holdTitan({
  hydraId,
  changed,
}: {
  hydraId: string
  changed(): void
}): Promise<() => Promise<void>> {
  const home = nativeHome()
  await home.run({ fn: () => home.ensure({ hydra: hydraId }) })
  const record = home.read({ hydra: hydraId })
  record.changed = changed
  home.held.add(hydraId)

  return async () => {
    home.held.delete(hydraId)
    record.changed = () => {}

    if (!home.held.size) {
      await home.close()
    }
  }
}

export function reloadTitan({ hydraId }: { hydraId: string }): void {
  const home = nativeHome()

  try {
    home.reload({ hydra: hydraId })
  } catch (error) {
    const record = home.records.get(hydraId)

    if (record) {
      record.stale = true
    }

    log({
      level: 'error',
      operation: 'hydra.reload',
      hydraId,
      error,
    })

    return
  }

  home.records.get(hydraId)?.changed()
}

export function writableTitan({
  hydraId,
}: {
  hydraId: string
  migrate?: boolean
}): Held {
  return nativeHome().read({ hydra: hydraId })
}

export function loadTitan({
  hydraId,
}: {
  hydraId: string
  migrate?: boolean
}): TitanSnapshot {
  const home = openedNativeHome()

  if (!home) {
    return readNativeTitan({ hydraId })
  }

  const {
    dir,
    state,
  } = home.read({ hydra: hydraId })

  return {
    dir,
    state,
  }
}

export function hydraExists({ hydraId }: { hydraId: string }): boolean {
  const home = openedNativeHome()

  return (home?.files.hydras() ?? nativeTitanIds()).includes(hydraId)
}

export function requireTitan({ hydraId }: { hydraId: string }): void {
  if (hydraId !== DEFAULT_TITAN && !hydraExists({ hydraId })) {
    throw new TitanError({
      code: 'NOT_FOUND',
      message: `unknown Titan: ${hydraId}`,
      help: ['Create a Titan from the header in the UI'],
    })
  }
}

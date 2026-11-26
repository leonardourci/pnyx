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

export const heldTitan = ({ titanId }: { titanId: string }): Held | undefined => {
  const home = openedNativeHome()

  return home?.held.has(titanId) ? home.read({ hydra: titanId }) : undefined
}

export async function holdTitan({
  titanId,
  changed,
}: {
  titanId: string
  changed(): void
}): Promise<() => Promise<void>> {
  const home = nativeHome()
  await home.run({ fn: () => home.ensure({ hydra: titanId }) })
  const record = home.read({ hydra: titanId })
  record.changed = changed
  home.held.add(titanId)

  return async () => {
    home.held.delete(titanId)
    record.changed = () => {}

    if (!home.held.size) {
      await home.close()
    }
  }
}

export function reloadTitan({ titanId }: { titanId: string }): void {
  const home = nativeHome()

  try {
    home.reload({ hydra: titanId })
  } catch (error) {
    const record = home.records.get(titanId)

    if (record) {
      record.stale = true
    }

    log({
      level: 'error',
      operation: 'titan.reload',
      titanId,
      error,
    })

    return
  }

  home.records.get(titanId)?.changed()
}

export function writableTitan({
  titanId,
}: {
  titanId: string
  migrate?: boolean
}): Held {
  return nativeHome().read({ hydra: titanId })
}

export function loadTitan({
  titanId,
}: {
  titanId: string
  migrate?: boolean
}): TitanSnapshot {
  const home = openedNativeHome()

  if (!home) {
    return readNativeTitan({ titanId })
  }

  const {
    dir,
    state,
  } = home.read({ hydra: titanId })

  return {
    dir,
    state,
  }
}

export function hydraExists({ titanId }: { titanId: string }): boolean {
  const home = openedNativeHome()

  return (home?.files.hydras() ?? nativeTitanIds()).includes(titanId)
}

export function requireTitan({ titanId }: { titanId: string }): void {
  if (titanId !== DEFAULT_TITAN && !hydraExists({ titanId })) {
    throw new TitanError({
      code: 'NOT_FOUND',
      message: `unknown Titan: ${titanId}`,
      help: ['Create a Titan from the header in the UI'],
    })
  }
}

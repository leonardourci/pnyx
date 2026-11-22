import { readNativeHydra } from './native-read.ts'
import type { HydraState } from './model.ts'
import { nativeHome, openedNativeHome, type NativeHeld } from './native-home.ts'
import { DEFAULT_HYDRA } from './home-migration.ts'
import { HydraError } from '#store/errors.ts'
import { log } from './diagnostics.ts'

export interface HydraSnapshot {
  dir: string
  state: HydraState
}

export type Held = NativeHeld

export const heldHydra = ({ hydraId }: { hydraId: string }): Held | undefined => {
  const home = nativeHome()

  return home.held.has(hydraId) ? home.read({ hydra: hydraId }) : undefined
}

export async function holdHydra({
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

export function reloadHydra({ hydraId }: { hydraId: string }): void {
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

export function writableHydra({
  hydraId,
}: {
  hydraId: string
  migrate?: boolean
}): Held {
  return nativeHome().read({ hydra: hydraId })
}

export function loadHydra({
  hydraId,
}: {
  hydraId: string
  migrate?: boolean
}): HydraSnapshot {
  const home = openedNativeHome()

  if (!home) {
    return readNativeHydra({ hydraId })
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
  return nativeHome().files.hydras().includes(hydraId)
}

export function requireHydra({ hydraId }: { hydraId: string }): void {
  if (hydraId !== DEFAULT_HYDRA && !hydraExists({ hydraId })) {
    throw new HydraError({
      code: 'NOT_FOUND',
      message: `unknown Hydra: ${hydraId}`,
      help: ['Create a Hydra from the header in the UI'],
    })
  }
}

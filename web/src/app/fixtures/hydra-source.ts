import type { HydraEvent, HydraState } from '#app/model.ts'
import type { HydraSummary } from '#app/server-hydras.ts'
import type { Settings } from '#settings/model.ts'
import type { HydraQueue } from '#hydra/wakes.ts'
import type { UpgradeStatus } from '#upgrade/model.ts'
import { emptyHydra, reduce } from '#app/reducer.ts'

// Keeps every part of the earlier value that reads the same, as Zero keeps an unchanged row.
function share<Value>({
  previous,
  next,
}: {
  previous: Value
  next: Value
}): Value {
  if (previous === next || typeof previous !== 'object' || typeof next !== 'object' || !previous || !next) {
    return next
  }

  if (Array.isArray(previous) !== Array.isArray(next)) {
    return next
  }

  const entries = Object.entries(next).map(([
    key,
    value,
  ]) => [
    key,
    share({
      previous: (previous as Record<string, unknown>)[key],
      next: value,
    }),
  ] as const)
  const same = Object.keys(previous).length === entries.length
    && entries.every(([
      key,
      value,
    ]) => (previous as Record<string, unknown>)[key] === value)

  if (same) {
    return previous
  }

  return (Array.isArray(next) ? entries.map(([
    , value,
  ]) => value) : Object.fromEntries(entries)) as Value
}

// Stands in for the Hydra data the page reads from Zero: a test shows a state, or one event applied to the last.
// The page gets no event ids, and a write that changed nothing reports nothing.
export function hydraSource() {
  const watched = new Map<string, {
    publish({
      state,
      queue,
    }: {
      state: HydraState
      queue: HydraQueue
    }): void
    state: HydraState
    queue: HydraQueue
    loaded: boolean
  }>()

  const show = ({
    state,
    queue,
    hydraId = 'default',
  }: {
    state: HydraState
    queue?: HydraQueue
    hydraId?: string
  }) => {
    const entry = watched.get(hydraId)

    if (!entry) {
      return
    }

    const next = share({
      previous: entry.state,
      next: {
        ...state,
        eventIds: {},
      },
    })

    const nextQueue = queue ?? entry.queue

    // Zero reports a Hydra once it loads, and then each write that changed a row.
    if (!entry.loaded || next !== entry.state || nextQueue !== entry.queue) {
      entry.loaded = true
      entry.state = next
      entry.queue = nextQueue
      entry.publish({
        state: next,
        queue: nextQueue,
      })
    }
  }

  return {
    watch: ({
      hydraId,
      publish,
    }: {
      hydraId: string
      publish({
        state,
        queue,
      }: {
        state: HydraState
        queue: HydraQueue
      }): void
    }) => {
      watched.set(
        hydraId,
        {
          publish,
          state: emptyHydra(),
          queue: {
            waiting: [],
            reading: [],
          },
          loaded: false,
        },
      )

      return {
        // Like Zero, a ref no row has comes back missing.
        open: async ({ refs }: { refs: string[] }) => {
          const shown = watched.get(hydraId)?.state

          return { unavailable: refs.filter(ref => !shown?.cards[ref] && !shown?.keys[ref]) }
        },
        close: () => {
          watched.delete(hydraId)
        },
      }
    },
    show,
    apply: ({
      event,
      hydraId = 'default',
    }: {
      event: HydraEvent
      hydraId?: string
    }) => show({
      state: reduce({
        state: watched.get(hydraId)?.state ?? emptyHydra(),
        event,
      }),
      hydraId,
    }),
  }
}

// Stands in for the Hydra list and shared settings the page reads from Zero.
export function sharedSource() {
  let shown: {
    hydras({ rows }: { rows: HydraSummary[] }): void
    upgrade({ status }: { status: UpgradeStatus | undefined }): void
    settings({
      settings,
      revision,
    }: {
      settings: Settings
      revision: number
    }): void
  } | undefined

  return {
    watch: ({
      hydras,
      settings,
      upgrade,
    }: NonNullable<typeof shown>) => {
      shown = {
        hydras,
        settings,
        upgrade,
      }

      return {
        close: () => {
          shown = undefined
        },
      }
    },
    hydras: ({ rows }: { rows: HydraSummary[] }) => shown?.hydras({ rows }),
    upgrade: ({ status }: { status: UpgradeStatus | undefined }) => shown?.upgrade({ status }),
    settings: ({
      settings,
      revision,
    }: {
      settings: Settings
      revision: number
    }) => shown?.settings({
      settings,
      revision,
    }),
  }
}

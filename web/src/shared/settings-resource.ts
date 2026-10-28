import type { Command, Receipt } from '#web-app/connection.ts'
import { CommandFailure, createPendingResource } from './pending-intents.ts'

export function createSettingsResource<State, Patch>({
  scope,
  project,
  represented,
  read,
  newer,
}: {
  scope: string
  project({
    state,
    patch,
  }: {
    state: State | null
    patch: Patch
  }): State | null
  represented({
    state,
    patch,
  }: {
    state: State
    patch: Patch
  }): boolean
  read({ receipt }: { receipt: Receipt }): State | undefined
  newer?({
    current,
    next,
  }: {
    current: State
    next: State
  }): boolean
}) {
  const resource = createPendingResource<State | null, Patch>({
    scope,
    confirmed: null,
    adapter: {
      project,
      represented: ({
        state,
        intent,
      }) => intent.stage === 'unknown' && state !== null && represented({
        state,
        patch: intent.patch,
      }),
    },
  })
  const listeners = new Set<() => void>()
  let readError = ''
  let failedWrite: string | undefined
  let generation = 0
  let refreshing: Promise<void> | undefined
  const queues = new Map<string, Promise<void>>()

  const readSnapshot = () => {
    const state = resource.snapshot()
    const failed = state.intents.find(intent => intent.id === failedWrite
      && [
        'refused',
        'unknown',
      ].includes(intent.stage))

    return {
      ...state,
      error: failed?.error?.message ?? readError,
    }
  }

  let snapshot = readSnapshot()

  const publish = () => {
    snapshot = readSnapshot()
    listeners.forEach(listener => listener())
  }

  resource.subscribe(publish)

  const refresh = ({
    command,
    name,
    args,
  }: {
    command: Command
    name: string
    args: string[]
  }) => {
    if (refreshing) {
      return refreshing
    }

    const version = generation

    const run = async () => {
      try {
        const receipt = await command({
          name,
          args,
        })

        if (version === generation) {
          const state = read({ receipt })
          const current = resource.snapshot().confirmed

          if (state !== undefined && (current === null || !newer || newer({
            current,
            next: state,
          }))) {
            resource.confirm({ state })
          }

          readError = ''
        }
      } catch (failure) {
        if (version === generation) {
          readError = failure instanceof Error ? failure.message : String(failure)
        }
      } finally {
        refreshing = undefined
        publish()
      }
    }

    refreshing = run()

    return refreshing
  }

  return {
    snapshot: () => snapshot,
    // eslint-disable-next-line pnyx/object-params -- React useSyncExternalStore subscription contract.
    subscribe(listener: () => void) {
      listeners.add(listener)

      return () => {
        listeners.delete(listener)
      }
    },
    refresh,
    async write({
      command,
      name,
      args,
      patch,
      targets,
      serial = 'settings',
    }: {
      command: Command
      name: string
      args: string[]
      patch: Patch
      targets: string[]
      serial?: string
    }) {
      const releaseScope = command.retain?.()
      const id = crypto.randomUUID()
      generation++
      failedWrite = undefined
      resource.enqueue({
        id,
        patch,
        targets,
        delivery: 'once',
      })
      const previous = queues.get(serial) ?? Promise.resolve()
      let release = () => {}
      queues.set(
        serial,
        new Promise<void>(resolve => {
          release = resolve
        }),
      )

      try {
        await previous
        resource.sending({ id })
        const receipt = await command({
          name,
          args,
        })
        const state = read({ receipt })
        generation++
        const current = resource.snapshot().confirmed

        if (state !== undefined && (current === null || !newer || newer({
          current,
          next: state,
        }))) {
          resource.confirm({ state })
          readError = ''
        }

        resource.accept({
          id,
          complete: true,
        })

        for (const intent of resource.snapshot().intents) {
          if (intent.id === id) {
            break
          }

          if (intent.stage === 'unknown' && intent.targets.every(target => targets.includes(target))) {
            resource.accept({
              id: intent.id,
              complete: true,
            })
          }
        }

        return receipt
      } catch (failure) {
        const reason = failure instanceof CommandFailure ? failure : new CommandFailure({
          message: failure instanceof Error ? failure.message : String(failure),
          code: 'UNKNOWN',
          outcome: 'unknown',
        })
        failedWrite = id

        if (reason.outcome === 'unknown') {
          resource.unknown({
            id,
            error: reason,
          })
        } else {
          resource.refuse({
            id,
            error: reason,
          })
        }

        throw reason
      } finally {
        release()
        releaseScope?.()
        publish()
      }
    },
  }
}

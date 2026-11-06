import { emptyHydra } from '#app/reducer.ts'
import type { HydraSummary } from '#app/server-hydras.ts'
import { moveHydraStorage } from '#web-hydra/outbox.ts'
import { pendingHydra } from './pending-state.ts'
import { CommandFailure } from '#web-shared/pending-intents.ts'
import { save, stored } from './connection-storage.ts'
import type { Creation, Scope, Request, HydraListResource } from './connection-model.ts'
import type { Receipt } from './connection.ts'

export function createHydraCreation({
  connection,
  scopes,
  requests,
  creations,
  hydras,
  namespace,
  creationKey,
  selectedKey,
  scopeFor,
  selection,
  publish,
  subscribe,
  command,
}: {
  connection: {
    selected: string
    listed: boolean
  }
  scopes: Map<string, Scope>
  requests: Map<string, Request>
  creations: Map<string, Creation>
  hydras: HydraListResource
  namespace: string
  creationKey: string
  selectedKey: string
  scopeFor({ id }: { id: string }): Scope
  selection(): Scope
  publish(): void
  subscribe({ scope }: { scope: Scope }): void
  command({
    scope,
    name,
    args,
    creation,
  }: {
    scope: Scope
    name: string
    args: string[]
    creation?: string
  }): Promise<Receipt>
}) {
  const saveCreations = () => save({
    key: creationKey,
    value: [...creations.values()],
  })

  const promote = ({
    scope,
    canonical,
  }: {
    scope: Scope
    canonical: HydraSummary
  }) => {
    if (scope.id === canonical.id) {
      return
    }

    const chosen = connection.selected === scope.id
    const previousId = scope.id
    const previousIdentity = scope.identity
    scopes.delete(scope.id)
    scope.id = canonical.id
    scope.identity = canonical.identity ?? canonical.id
    moveHydraStorage({
      storage: sessionStorage,
      from: previousIdentity,
      to: scope.identity,
    })
    moveHydraStorage({
      storage: localStorage,
      from: previousId,
      to: canonical.id,
    })
    scope.resource = pendingHydra({
      scope: `${namespace}/hydra/${canonical.id}/`,
      confirmed: emptyHydra(),
    })
    scopes.set(
      canonical.id,
      scope,
    )
    creations.delete(scope.creation!.attempt)
    saveCreations()

    if (chosen) {
      connection.selected = canonical.id
      save({
        key: selectedKey,
        value: null,
      })
      history.replaceState(
        null,
        '',
        `/hydra/${canonical.id}/`,
      )
    }

    hydras.accept({
      id: scope.creation!.attempt,
      complete: true,
    })
    subscribe({ scope })
  }

  const updateHydras = ({ rows }: { rows: HydraSummary[] }) => {
    connection.listed = true
    hydras.confirm({ state: rows })

    for (const scope of [...scopes.values()]) {
      if (!scope.creation || !scope.id.startsWith('pending-')) {
        continue
      }

      const canonical = rows.find(hydra => hydra.creationAttempt === scope.creation!.attempt)

      if (!canonical) {
        continue
      }

      promote({
        scope,
        canonical,
      })

      for (const request of requests.values()) {
        if (request.creation === scope.creation.attempt) {
          clearTimeout(request.timer)
          requests.delete(request.id)
          request.resolve({
            receipt: {
              creation: {
                hydraId: canonical.id,
                attempt: scope.creation.attempt,
                status: 'saved',
                mount: 'pending',
              },
              hydras: rows,
            },
          })
        }
      }
    }
  }

  const attemptCreation = async ({
    creation,
    choose,
    push = false,
    restoring = false,
  }: {
    creation: Creation
    choose: boolean
    push?: boolean
    restoring?: boolean
  }) => {
    const id = `pending-${creation.attempt}`
    const scope = scopeFor({ id })
    scope.creation = creation
    scope.viewKey = id
    scope.failed = false
    scope.error = ''
    const refusal = restoring ? creation.refusal : undefined

    if (!restoring) {
      delete creation.refusal
    }

    creations.set(
      creation.attempt,
      creation,
    )
    saveCreations()
    const previous = hydras.snapshot().intents.find(intent => intent.id === creation.attempt)

    if (previous && [
      'refused',
      'unknown',
    ].includes(previous.stage)) {
      hydras.retry({ id: creation.attempt })
    } else if (!previous) {
      hydras.enqueue({
        id: creation.attempt,
        targets: [id],
        patch: {
          id,
          name: creation.name,
          icon: creation.icon,
          // Created now, so it sorts last until the server's summary arrives.
          order: Date.now(),
          hydra: 'Hydra',
          projects: [],
          creationAttempt: creation.attempt,
        },
        delivery: 'idempotent',
      })
    }

    if (restoring) {
      hydras.unknown({
        id: creation.attempt,
        error: new CommandFailure({
          message: 'Checking the saved creation attempt.',
          code: 'UNCONFIRMED',
          outcome: 'unknown',
        }),
      })
    }

    if (choose) {
      connection.selected = id
      save({
        key: selectedKey,
        value: creation.attempt,
      })

      if (push) {
        history.pushState(
          null,
          '',
          location.href,
        )
      }
    }

    if (refusal) {
      scope.failed = true
      scope.error = refusal.message
      hydras.refuse({
        id: creation.attempt,
        error: new CommandFailure(refusal),
      })
      publish()

      return
    }

    publish()

    const args = [
      'create',
      creation.name,
      creation.attempt,
    ]

    if (creation.icon) {
      args.push(creation.icon)
    }

    try {
      const receipt = await command({
        scope: scopeFor({ id: creation.from }),
        name: 'hydras',
        args,
        creation: creation.attempt,
      })
      const outcome = receipt.creation as { hydraId: string }
      const canonical = (receipt.hydras as HydraSummary[])
        .find(hydra => hydra.id === outcome.hydraId)!
      promote({
        scope,
        canonical,
      })
      publish()
    } catch (error) {
      scope.failed = true
      scope.error = error instanceof Error ? error.message : String(error)

      if (error instanceof CommandFailure && error.outcome === 'refused') {
        creation.refusal = {
          message: error.message,
          code: error.code,
        }
        saveCreations()
      }

      for (const request of requests.values()) {
        if (request.scope === scope) {
          requests.delete(request.id)
          clearTimeout(request.timer)
          request.reject({ error: error instanceof Error ? error : new Error(String(error)) })
        }
      }

      publish()
      throw error
    }
  }

  const create = ({
    name,
    icon,
  }: {
    name: string
    icon: string
  }) => attemptCreation({
    creation: {
      attempt: crypto.randomUUID(),
      from: selection().id,
      name,
      icon,
    },
    choose: true,
    push: true,
  })
  let restoredCreations = false

  const restoreCreations = () => {
    if (restoredCreations) {
      return
    }

    restoredCreations = true
    const chosen = stored<string | null>({
      key: selectedKey,
      fallback: null,
    })
    const saved = stored<Creation[]>({
      key: creationKey,
      fallback: [],
    })

    if (!Array.isArray(saved)) {
      return
    }

    for (const creation of saved) {
      if (!creation || typeof creation.attempt !== 'string' || !/^[a-z0-9-]{1,128}$/i.test(creation.attempt)
        || typeof creation.from !== 'string' || !/^[a-z0-9._-]+$/.test(creation.from) || typeof creation.name !== 'string' || (creation.refusal !== undefined
          && (typeof creation.refusal.message !== 'string' || typeof creation.refusal.code !== 'string'))) {
        continue
      }

      void attemptCreation({
        creation,
        choose: chosen === creation.attempt,
        restoring: true,
      }).catch(() => {})
    }
  }

  return {
    saveCreations,
    promote,
    updateHydras,
    attemptCreation,
    create,
    restoreCreations,
  }
}

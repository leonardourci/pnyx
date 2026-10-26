export type IntentStage = 'pending' | 'sending' | 'accepted' | 'confirmed' | 'refused' | 'unknown'

export class CommandFailure extends Error {
  code: string
  help: string[]
  outcome: 'refused' | 'unknown'

  constructor({
    message,
    code,
    help = [],
    outcome = 'refused',
  }: {
    message: string
    code: string
    help?: string[]
    outcome?: 'refused' | 'unknown'
  }) {
    super(message)
    this.name = 'CommandFailure'
    this.code = code
    this.help = help
    this.outcome = outcome
  }
}

export interface PendingIntent<Patch> {
  id: string
  scope: string
  targets: string[]
  dependencies: string[]
  patch: Patch
  delivery: 'idempotent' | 'once'
  stage: IntentStage
  error?: CommandFailure
}

export interface IntentAdapter<State, Patch> {
  project({
    state,
    patch,
  }: {
    state: State
    patch: Patch
  }): State
  represented({
    state,
    intent,
  }: {
    state: State
    intent: PendingIntent<Patch>
  }): boolean
}

export function createPendingResource<State, Patch>({
  scope,
  confirmed,
  adapter,
}: {
  scope: string
  confirmed: State
  adapter: IntentAdapter<State, Patch>
}) {
  let intents: PendingIntent<Patch>[] = []
  let snapshot = {
    confirmed,
    view: confirmed,
    intents,
  }
  const listeners = new Set<() => void>()
  const active = ({ intent }: { intent: PendingIntent<Patch> }) => ![
    'confirmed',
    'refused',
  ].includes(intent.stage)

  const refuse = ({
    id,
    error,
  }: {
    id: string
    error: CommandFailure
  }) => {
    const refused = new Set([id])

    intents = intents.map(intent => {
      if (!active({ intent })) {
        return intent
      }

      const dependent = intent.dependencies.some(id => refused.has(id))

      if (intent.id !== id && !dependent) {
        return intent
      }

      refused.add(intent.id)

      return {
        ...intent,
        stage: 'refused',
        error: dependent ? new CommandFailure({
          message: `Prerequisite refused: ${error.message}`,
          code: 'DEPENDENCY_REFUSED',
        }) : error,
      }
    })
  }

  const publish = () => {
    let view = confirmed

    for (let index = 0; index < intents.length; index++) {
      const intent = intents[index]!

      if (!active({ intent })) {
        continue
      }

      if (adapter.represented({
        state: confirmed,
        intent,
      })) {
        intents = intents.map(item => item.id === intent.id ? {
          ...item,
          stage: 'confirmed',
          error: undefined,
        } : item)
        continue
      }

      try {
        view = adapter.project({
          state: view,
          patch: intent.patch,
        })
      } catch (error) {
        refuse({
          id: intent.id,
          error: error instanceof CommandFailure ? error : new CommandFailure({
            message: String(error),
            code: 'INVALID_PREVIEW',
          }),
        })
      }
    }

    // Bound completed history while retaining every unresolved operation and its dependencies.
    const required = new Set(intents.filter(intent => active({ intent }))
      .flatMap(intent => intent.dependencies))
    const recent = new Set(intents.filter(intent => !active({ intent })).slice(-30)
      .map(intent => intent.id))
    intents = intents.filter(intent => active({ intent })
      || required.has(intent.id) || recent.has(intent.id))
    snapshot = {
      confirmed,
      view,
      intents,
    }
    listeners.forEach(listener => listener())
  }

  const transition = ({
    id,
    stage,
    error,
  }: {
    id: string
    stage: IntentStage
    error?: CommandFailure
  }) => {
    intents = intents.map(intent => intent.id === id && active({ intent }) ? {
      ...intent,
      stage,
      error,
    } : intent)
    publish()
  }

  return {
    snapshot: () => snapshot,
    // eslint-disable-next-line pnyx/object-params -- React useSyncExternalStore subscription contract.
    subscribe: (listener: () => void) => {
      listeners.add(listener)

      return () => {
        listeners.delete(listener)
      }
    },
    enqueue({
      id,
      targets,
      patch,
      dependencies = [],
      delivery,
    }: {
      id: string
      targets: string[]
      patch: Patch
      dependencies?: string[]
      delivery: PendingIntent<Patch>['delivery']
    }) {
      if (intents.some(intent => intent.id === id)) {
        return
      }

      if (dependencies.some(id => !intents.some(intent => intent.id === id && intent.stage !== 'refused'))) {
        throw new CommandFailure({
          message: 'Prerequisite unavailable',
          code: 'DEPENDENCY_REFUSED',
        })
      }

      intents = [
        ...intents,
        {
          id,
          scope,
          targets: [...targets],
          patch,
          dependencies: [...dependencies],
          delivery,
          stage: 'pending',
        },
      ]
      publish()
    },
    confirm({ state }: { state: State }) {
      confirmed = state
      publish()
    },
    sending({ id }: { id: string }) {
      transition({
        id,
        stage: 'sending',
      })
    },
    accept({
      id,
      complete = false,
    }: {
      id: string
      complete?: boolean
    }) {
      transition({
        id,
        stage: complete ? 'confirmed' : 'accepted',
      })
    },
    unknown({
      id,
      error,
    }: {
      id: string
      error: CommandFailure
    }) {
      transition({
        id,
        stage: 'unknown',
        error,
      })
    },
    refuse({
      id,
      error,
    }: {
      id: string
      error: CommandFailure
    }) {
      refuse({
        id,
        error,
      })
      publish()
    },
  }
}

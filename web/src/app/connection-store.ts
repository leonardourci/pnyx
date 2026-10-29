import { saveEventId, savedReceipt, type SaveCommand } from '#app/save-receipts.ts'
import { moveHydraStorage, readSettingsSaves, saveSettingsSaves } from '#web-hydra/outbox.ts'
import { reminderTime } from '#tasks/time.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { hydraConfig } from '#hydra/config.ts'
import { emptyHydra, reduce } from '#app/reducer.ts'
import type { HydraState } from '#app/model.ts'
import type { ServerMessage } from '#app/server-transport.ts'
import type { UpgradeStatus } from '#upgrade/model.ts'
import type { HydraSummary } from '#app/server-hydras.ts'
import type { HydraQueue } from '#hydra/wakes.ts'
import type { LatestMessage, ThreadPage } from '#hydra/transcripts-read.ts'
import type { CurrentAction } from '#hydra/calls.ts'
import type { Command, Receipt } from './connection.ts'
import { commandTimeout, reconnectDelay, retryable, withChanges } from './connection-protocol.ts'
import { argument, optimisticState, currentRevision } from '#web-tasks/optimistic.ts'
import { commandArguments, editTargets, pendingHydra, type HydraResource } from './pending-state.ts'
import { CommandFailure, createPendingResource } from '#web-shared/pending-intents.ts'
import { DISPATCH_CHANGED } from '#web-workers/heads-dispatch.ts'
import { shouldReload } from './view.ts'
import { noteUpdate, staleUpdates } from '#web-tasks/updates-cache.ts'

const emptyQueue = (): HydraQueue => ({
  waiting: [],
  reading: [],
})
interface Creation {
  attempt: string
  from: string
  name: string
  icon?: string
  refusal?: {
    message: string
    code: string
  }
}
interface Scope {
  id: string
  identity: string
  viewKey: string
  resource: HydraResource
  hasSnapshot: boolean
  ready: boolean
  subscribed: boolean
  subscription: string | null
  failed: boolean
  restoredSaves: boolean
  error: string
  thread: ThreadPage | null
  queue: HydraQueue
  latest: Record<string, LatestMessage>
  actions: Record<string, CurrentAction>
  command: Command
  leases: number
  creation?: Creation
  persistTimer?: ReturnType<typeof setTimeout>
}
interface Request {
  id: string
  scope: Scope
  name: string
  args: string[]
  optimistic: boolean
  dependencies: string[]
  retry: boolean
  sent: boolean
  creation?: string
  saveId?: string
  checking?: boolean
  unconfirmed(): void
  timer?: ReturnType<typeof setTimeout>
  resolve({ receipt }: { receipt: Receipt }): void
  reject({ error }: { error: Error }): void
}

function stored<Value>({
  key,
  fallback,
}: {
  key: string
  fallback: Value
}): Value {
  try {
    return JSON.parse(sessionStorage.getItem(key) ?? 'null') ?? fallback
  } catch {
    return fallback
  }
}

function save({
  key,
  value,
}: {
  key: string
  value: unknown
}) {
  try {
    sessionStorage.setItem(
      key,
      JSON.stringify(value),
    )
  } catch { /* The open tab retains its pending work when storage is full or blocked. */ }
}

export function createHydraConnection() {
  const origin = location.origin
  const installation = document.querySelector<HTMLMetaElement>('meta[name=pnyx-installation]')?.content
    ?? document.querySelector<HTMLMetaElement>('meta[name=pnyx-hydra]')?.content ?? ''
  const namespace = `${origin}:${installation}`
  const initialId = location.pathname.split('/')[2] ?? 'default'
  const scopes = new Map<string, Scope>()
  const requests = new Map<string, Request>()
  const listeners = new Set<() => void>()
  const creationKey = `pnyx:${namespace}:hydra-creations`
  const selectedKey = `pnyx:${namespace}:selected-creation`
  const creations = new Map<string, Creation>()
  let selected = initialId
  let socket: WebSocket | null = null
  let physicalHydra: string | null = null
  let listed = false
  let active = false
  let generation = 0
  let attempt = 0
  let received = Date.now()
  let reconnect: ReturnType<typeof setTimeout> | undefined
  let upgrade: UpgradeStatus | undefined
  let watchdog: ReturnType<typeof setInterval> | undefined

  const hydras = createPendingResource<HydraSummary[], HydraSummary>({
    scope: `${namespace}/hydras`,
    confirmed: [],
    adapter: {
      project: ({
        state,
        patch,
      }) => [
        ...state.filter(hydra => hydra.id !== patch.id),
        patch,
      ],
      represented: ({
        state,
        intent,
      }) => state.some(hydra => hydra.creationAttempt === intent.patch.creationAttempt),
    },
  })
  const keyFor = ({ id }: { id: string }) => `pnyx:${namespace}/hydra/${id}/:hydra-state`

  const scopeFor = ({ id }: { id: string }): Scope => {
    const existing = scopes.get(id)

    if (existing) {
      return existing
    }

    const summary = hydras.snapshot().view.find(hydra => hydra.id === id)
    const identity = summary?.identity ?? (id === initialId
      ? document.querySelector<HTMLMetaElement>('meta[name=pnyx-hydra]')?.content ?? id : id)
    const legacy = stored({
      key: `pnyx:${identity}:hydra-state`,
      fallback: emptyHydra(),
    })
    const restored = stored({
      key: keyFor({ id }),
      fallback: legacy,
    })
    const confirmed = restored?.v === 1 && restored.cards ? restored : emptyHydra()
    const scope: Scope = {
      id,
      identity,
      viewKey: id,
      resource: pendingHydra({
        scope: `${namespace}/hydra/${id}/`,
        confirmed,
      }),
      hasSnapshot: !!confirmed.config,
      ready: false,
      subscribed: false,
      subscription: null,
      failed: false,
      restoredSaves: false,
      error: '',
      thread: null,
      queue: emptyQueue(),
      latest: {},
      actions: {},
      leases: 0,
      command: ({
        name,
        args,
        onChecking,
      }) => command({
        scope,
        name,
        args,
        onChecking,
      }),
    }

    scope.command.retain = () => {
      scope.leases++

      return () => {
        scope.leases--
        releaseInactive()
      }
    }

    scopes.set(
      id,
      scope,
    )

    for (const intent of scope.resource.snapshot().intents) {
      if ([
        'confirmed',
        'refused',
      ].includes(intent.stage) || intent.delivery !== 'idempotent'
        || requests.has(intent.id)) {
        continue
      }

      requests.set(
        intent.id,
        {
          id: intent.id,
          scope,
          name: intent.patch.name,
          args: intent.patch.args,
          optimistic: true,
          dependencies: intent.dependencies,
          saveId: saveEventId({
            command: {
              type: 'command',
              id: intent.id,
              ...intent.patch,
            },
          }),
          retry: true,
          checking: intent.stage === 'unknown',
          sent: false,
          unconfirmed: () => {},
          resolve: () => {},
          reject: ({ error }) => {
            scope.error = error.message
          },
        },
      )
    }

    return scope
  }

  const shell = ({ scope }: { scope: Scope }): HydraState => {
    const state = emptyHydra()
    const summary = hydras.snapshot().view.find(hydra => hydra.id === scope.id)

    return {
      ...state,
      config: {
        ...hydraConfig({
          state,
          id: scope.id,
        }),
        name: summary?.name ?? '',
      },
    }
  }

  const selection = () => scopeFor({ id: selected })

  const visible = () => {
    const scope = selection()
    const resource = scope.resource.snapshot()

    return {
      state: scope.hasSnapshot ? resource.view : shell({ scope }),
      viewKey: scope.viewKey,
      connected: scope.ready && socket?.readyState === WebSocket.OPEN,
      loaded: scope.hasSnapshot || scope.failed,
      loading: scope.ready || scope.failed ? '' : scope.id,
      checking: [...requests.values()].some(request => request.scope === scope && request.checking),
      creating: !!scope.creation && scope.id.startsWith('pending-'),
      error: scope.error,
      hydraThread: scope.thread,
      hydraQueue: scope.queue,
      upgrade,
      latest: scope.latest,
      actions: scope.actions,
      navigation: {
        hydraId: scope.id,
        hydras: hydras.snapshot().view.map(hydra => {
          const preview = scopes.get(hydra.id)?.resource.snapshot().view.config

          return preview ? {
            ...hydra,
            name: preview.name,
          } : hydra
        }),
      },
      edits: resource.intents,
      intents: [
        ...resource.intents,
        ...hydras.snapshot().intents.filter(intent => intent.patch.id === scope.viewKey),
      ],
    }
  }

  let snapshot = visible()

  const metadata = () => {
    document.querySelector<HTMLMetaElement>('meta[name=pnyx-hydra]')?.setAttribute(
      'content',
      selection().identity,
    )
    document.querySelector('base')?.setAttribute(
      'href',
      `/hydra/${selection().id}/`,
    )
  }

  const publish = () => {
    for (const request of requests.values()) {
      const intent = request.scope.resource.snapshot().intents
        .find(intent => intent.id === request.id)

      const failed = request.scope.resource.snapshot().intents.find(intent =>
        request.dependencies.includes(intent.id) && intent.stage === 'refused')

      if (failed || (intent?.stage === 'refused' && intent.error)) {
        const error = intent?.error ?? new CommandFailure({
          message: 'The prerequisite was refused. Your dependent action was not sent.',
          code: 'DEPENDENCY_REFUSED',
        })
        clearTimeout(request.timer)
        requests.delete(request.id)
        request.reject({ error })
        request.scope.error = error.message
      }
    }

    releaseInactive()
    metadata()
    snapshot = visible()
    listeners.forEach(listener => listener())
  }

  const persist = ({ scope }: { scope: Scope }) => {
    if (!scope.hasSnapshot) {
      return
    }

    save({
      key: keyFor({ id: scope.id }),
      value: scope.resource.snapshot().confirmed,
    })
    save({
      key: `pnyx:${scope.identity}:hydra-state`,
      value: scope.resource.snapshot().confirmed,
    })
  }

  const persistSoon = ({ scope }: { scope: Scope }) => {
    clearTimeout(scope.persistTimer)
    scope.persistTimer = setTimeout(
      () => persist({ scope }),
      250,
    )
  }

  const saveCommand = ({ request }: { request: Request }): SaveCommand => ({
    type: 'command',
    id: request.id,
    name: request.name,
    args: request.args,
  })

  const persistSaves = ({ scope }: { scope: Scope }) => saveSettingsSaves({
    hydraId: scope.identity,
    commands: [...requests.values()].filter(request => request.scope === scope && request.name === 'hydra-agent')
      .map(request => saveCommand({ request })),
  })

  const confirmSaves = ({ scope }: { scope: Scope }) => {
    for (const request of requests.values()) {
      if (request.scope !== scope || (!request.saveId && !request.optimistic)) {
        continue
      }

      const state = scope.resource.snapshot().confirmed
      let receipt = savedReceipt({
        command: saveCommand({ request }),
        state,
      })
      const eventId = request.optimistic ? argument({
        args: request.args,
        flag: '--event-id',
      }) : undefined
      const seq = eventId && state.eventIds[eventId]

      if (!receipt && typeof seq === 'number') {
        receipt = {
          type: 'receipt',
          id: request.id,
          saved: true,
          event: {
            id: eventId,
            seq,
          },
        }
      }

      if (receipt) {
        clearTimeout(request.timer)
        requests.delete(request.id)
        request.resolve({ receipt })
      }
    }

    persistSaves({ scope })
  }

  const send = ({ message }: { message: unknown }) => {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message))
    }
  }

  function releaseInactive() {
    if (socket?.readyState !== WebSocket.OPEN) {
      return
    }

    for (const scope of scopes.values()) {
      if (scope.id === selected || !scope.subscribed || scope.id.startsWith('pending-')) {
        continue
      }

      if (scope.id === physicalHydra && !listed) {
        continue
      }

      const outstanding = [...requests.values()].some(request => request.scope === scope)
      const unresolved = scope.resource.snapshot().intents.some(intent => ![
        'confirmed',
        'refused',
      ].includes(intent.stage))

      if (outstanding || unresolved || scope.leases > 0) {
        continue
      }

      send({
        message: {
          type: 'unsubscribe',
          scope: scope.id,
        },
      })
      scope.subscribed = false
      scope.ready = false
    }
  }

  const subscribe = ({ scope }: { scope: Scope }) => {
    if (scope.id.startsWith('pending-') || scope.subscribed || !physicalHydra || socket?.readyState !== WebSocket.OPEN) {
      return
    }

    scope.subscribed = true
    scope.subscription = crypto.randomUUID()
    scope.ready = false
    send({
      message: {
        type: 'subscribe',
        scope: scope.id,
        subscription: scope.subscription,
        ...(scope.hasSnapshot ? { after: String(scope.resource.snapshot().confirmed.seq) } : {}),
      },
    })
  }

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

    const chosen = selected === scope.id
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
      selected = canonical.id
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
    listed = true
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

  const flush = () => {
    if (socket?.readyState !== WebSocket.OPEN) {
      return
    }

    const editing = new Set<Scope>()

    for (const scope of scopes.values()) {
      if (scope.resource.snapshot().intents.some(intent => intent.stage === 'accepted')) {
        editing.add(scope)
      }
    }

    for (const request of requests.values()) {
      if (request.sent && request.optimistic) {
        editing.add(request.scope)
      }
    }

    for (const request of requests.values()) {
      const waitingForTarget = request.scope.resource.snapshot().intents.some(intent =>
        request.dependencies.includes(intent.id) && intent.stage !== 'confirmed')
      const blocked = waitingForTarget || (request.optimistic && editing.has(request.scope))

      if (request.sent || !request.scope.ready || blocked) {
        continue
      }

      const intent = request.scope.resource.snapshot().intents
        .find(intent => intent.id === request.id)

      if (intent?.stage === 'refused') {
        continue
      }

      if (request.optimistic) {
        editing.add(request.scope)
        request.args = currentRevision({
          state: request.scope.resource.snapshot().confirmed,
          edit: request,
        })
        request.scope.resource.sending({ id: request.id })
      }

      request.sent = true
      request.timer = setTimeout(
        () => {
          const error = new CommandFailure({
            message: 'Send could not be confirmed. Check its outcome before retrying.',
            code: 'TIMEOUT',
            outcome: 'unknown',
          })

          if (request.saveId) {
            request.checking = true
            request.unconfirmed()
            request.sent = false
            publish()
            flush()

            return
          }

          if (request.optimistic || request.creation) {
            request.scope.resource.unknown({
              id: request.id,
              error,
            })

            if (request.creation) {
              hydras.unknown({
                id: request.creation,
                error,
              })
            }

            socket?.close()
          } else {
            requests.delete(request.id)
            request.reject({ error })
            request.scope.error = error.message
          }

          publish()
        },
        commandTimeout(request),
      )
      send({
        message: {
          type: 'command',
          scope: request.scope.id,
          id: request.id,
          name: request.name,
          args: request.args,
        },
      })
    }
  }

  function command({
    scope,
    name,
    args,
    creation,
    onChecking,
    savedId,
  }: {
    scope: Scope
    name: string
    args: string[]
    creation?: string
    onChecking?(): void
    savedId?: string
  }): Promise<Receipt> {
    return new Promise((
      resolve,
      reject,
    ) => {
      if (!document.querySelector<HTMLMetaElement>('meta[name=pnyx-token]')?.content) {
        reject(new CommandFailure({
          message: 'Open this Hydra through pnyx-axi serve to send. Draft kept.',
          code: 'UNAUTHORIZED',
        }))

        return
      }

      if (name === 'task' && args[0] === 'remind' && args[2] !== 'clear') {
        args = [...args]
        args[2] = reminderTime({
          when: args[2] ?? '',
          now: new Date().toISOString(),
        })
      }

      const id = savedId ?? crypto.randomUUID()
      const confirmed = savedReceipt({
        command: {
          type: 'command',
          id,
          name,
          args,
        },
        state: scope.resource.snapshot().confirmed,
      })

      if (confirmed) {
        resolve(confirmed)

        return
      }

      let optimistic: boolean

      try {
        const view = scope.resource.snapshot().view
        optimistic = optimisticState({
          state: view,
          edit: {
            name,
            args,
          },
        }) !== view
        args = commandArguments({
          id,
          edit: {
            name,
            args,
          },
          persisted: optimistic,
          scope: scope.id,
        })
      } catch (error) {
        reject(error)

        return
      }

      const retry = optimistic || !!creation || retryable({
        name,
        args,
      })

      if ((!scope.ready || socket?.readyState !== WebSocket.OPEN) && !retry) {
        reject(new CommandFailure({
          message: 'This Hydra is still connecting. Try again when it is ready.',
          code: 'NOT_RUNNING',
        }))

        return
      }

      const dependencies = scope.resource.snapshot().intents.filter(intent => {
        const isPending = ![
          'refused',
          'confirmed',
        ].includes(intent.stage)
        const isCreation = [
          'column',
          'task',
        ].includes(intent.patch.name)
          && intent.patch.args[0] === 'create'
        const targetsArgument = args.some(arg => intent.targets.includes(arg))

        return isPending && isCreation && targetsArgument
      }).map(intent => intent.id)

      if (optimistic) {
        const edit = {
          name,
          args,
        }
        const targets = editTargets({ edit })

        scope.resource.enqueue({
          id,
          targets,
          patch: edit,
          dependencies,
          delivery: 'idempotent',
        })
      }

      const saveId = saveEventId({
        command: {
          type: 'command',
          id,
          name,
          args,
        },
      })
      requests.set(
        id,
        {
          id,
          scope,
          name,
          args,
          optimistic,
          dependencies,
          retry,
          sent: false,
          creation,
          saveId,
          unconfirmed: () => onChecking?.(),
          resolve: ({ receipt }) => resolve(receipt),
          reject: ({ error }) => reject(error),
        },
      )

      if (optimistic || creation || saveId) {
        scope.error = ''
      }

      persistSaves({ scope })
      publish(); subscribe({ scope }); flush()
    })
  }

  const receive = ({ message }: { message: ServerMessage }) => {
    if (message.type === 'pong') {
      return
    }

    if (!message.scope) {
      return
    }

    const scope = scopeFor({ id: message.scope })
    const response = 'id' in message && !!message.id

    if (physicalHydra && !response && scope.subscription !== message.subscription) {
      return
    }

    if (!scope.subscribed && !response && message.type !== 'hello') {
      return
    }

    if (message.type === 'hello' && physicalHydra && !scope.subscribed) {
      return
    }

    if (message.type === 'hello') {
      // A restarted server sends its own answer once its check has one.
      upgrade = undefined

      if (message.installation !== installation) {
        active = false
        scope.ready = false
        scope.failed = true
        scope.error = 'This address now serves another Pnyx installation. Reload to continue.'
        clearInterval(watchdog)
        socket?.close()
        publish()

        return
      }

      if (!physicalHydra) {
        physicalHydra = message.scope
        scope.subscribed = true
        scope.subscription = message.subscription ?? null
        subscribe({ scope: selection() })

        for (const request of requests.values()) {
          subscribe({ scope: request.scope })
        }
      }

      scope.identity = message.hydraId

      if (!scope.restoredSaves) {
        scope.restoredSaves = true

        for (const saved of readSettingsSaves({ hydraId: scope.identity })) {
          if (!requests.has(saved.id)) {
            void command({
              scope,
              name: saved.name,
              args: saved.args,
              savedId: saved.id,
            }).catch((error: Error) => {
              scope.error = error.message
              publish()
            })
          }
        }
      }

      if (shouldReload({
        loaded: document.querySelector<HTMLMetaElement>('meta[name=pnyx-build]')?.content,
        server: message.build,
      })) {
        location.reload()

        return
      }
    } else if (message.type === 'scope-error') {
      scope.error = message.error
      scope.failed = true
      scope.ready = false
      scope.subscribed = false
    } else if (message.type === 'snapshot') {
      scope.resource.confirm({ state: message.state })
      scope.hasSnapshot = true
      confirmSaves({ scope })
      scope.queue = emptyQueue()

      if (selected === scope.id) {
        staleUpdates()
      }

      persistSoon({ scope })
    } else if (message.type === 'event') {
      const state = scope.resource.snapshot().confirmed

      if (message.event.seq <= state.seq) {
        return
      }

      if (message.event.seq !== state.seq + 1) {
        scope.ready = false
        send({
          message: {
            type: 'resync',
            scope: scope.id,
          },
        })
        publish()

        return
      }

      scope.resource.confirm({
        state: reduce({
          state,
          event: message.event,
        }),
      })

      confirmSaves({ scope })

      if (selected === scope.id) {
        noteUpdate({ event: message.event })
      }

      persistSoon({ scope })
    } else if (message.type === 'latest') {
      if (message.spend) {
        const state = scope.resource.snapshot().confirmed
        const cards = { ...state.cards }

        for (const [
          id,
          spend,
        ] of Object.entries(message.spend)) {
          if (cards[id]) {
            cards[id] = {
              ...cards[id],
              spend,
            }
          }
        }

        scope.resource.confirm({
          state: {
            ...state,
            cards,
          },
        })
      }

      scope.latest = withChanges({
        current: scope.latest,
        changes: message.messages,
      })
      scope.actions = withChanges({
        current: scope.actions,
        changes: message.actions,
      })
      const wasReady = scope.ready
      scope.ready = true
      scope.failed = false
      attempt = 0

      if (!wasReady) {
        window.dispatchEvent(new Event(DISPATCH_CHANGED))

        if (scope.id === physicalHydra || scope.id === selected) {
          void command({
            scope,
            name: 'hydras',
            args: [],
          }).catch((error: Error) => {
            scope.error = error.message; publish()
          })
        }
      }
    } else if (message.type === 'thread') {
      if (message.thread.card === HYDRA_CARD) {
        scope.thread = message.thread
      }
    } else if (message.type === 'hydraQueue') {
      scope.queue = message.queue
    } else if (message.type === 'hydras') {
      updateHydras({ rows: message.hydras })
    } else if (message.type === 'upgrade') {
      upgrade = message.upgrade
    } else if ('id' in message && message.id) {
      if (message.type !== 'error' && Array.isArray(message.hydras)) {
        updateHydras({ rows: message.hydras as HydraSummary[] })
      }

      const request = requests.get(message.id)

      if (!request || request.scope !== scope) {
        publish(); flush()

        return
      }

      if (message.type === 'error' && request.saveId && message.saved !== false) {
        request.checking = true
        request.unconfirmed()
        publish()

        return
      }

      clearTimeout(request.timer)
      requests.delete(message.id)
      persistSaves({ scope })

      if (message.type === 'error') {
        const error = new CommandFailure({
          message: message.error,
          code: message.code,
          help: message.help,
        })

        if (request.optimistic) {
          scope.resource.refuse({
            id: request.id,
            error,
          })
        }

        if (request.creation) {
          hydras.refuse({
            id: request.creation,
            error,
          })
        }

        scope.error = message.error
        request.reject({ error })
      } else {
        if (request.optimistic) {
          scope.resource.accept({
            id: request.id,
            complete: message.event === 'none: unchanged',
          })
        }

        if ([
          'rule',
          'account',
        ].includes(request.name) && request.args[0] !== 'list') {
          window.dispatchEvent(new Event(DISPATCH_CHANGED))
        }

        if (request.name === 'thread' && (message.thread as ThreadPage | undefined)?.card === HYDRA_CARD) {
          scope.thread = message.thread as ThreadPage
        }

        request.resolve({ receipt: message })
      }
    }

    publish(); flush()
  }

  const disconnected = () => {
    physicalHydra = null
    listed = false

    for (const scope of scopes.values()) {
      scope.ready = false; scope.subscribed = false; scope.subscription = null
    }

    for (const request of requests.values()) {
      clearTimeout(request.timer)

      if (request.retry) {
        if (request.saveId || request.optimistic) {
          request.checking = true
          request.unconfirmed()
        }

        if (request.sent) {
          const error = new CommandFailure({
            message: 'Connection lost before confirmation.',
            code: 'DISCONNECTED',
            outcome: 'unknown',
          })

          if (request.optimistic) {
            request.scope.resource.unknown({
              id: request.id,
              error,
            })
          }

          if (request.creation) {
            hydras.unknown({
              id: request.creation,
              error,
            })
          }
        }

        request.sent = false
      } else {
        requests.delete(request.id)
        request.reject({
          error: new CommandFailure({
            message: 'Send interrupted. Draft kept; check the outcome before retrying.',
            code: 'DISCONNECTED',
            outcome: 'unknown',
          }),
        })
      }
    }

    publish()
  }

  const connect = () => {
    if (!active) {
      return
    }

    const token = document.querySelector<HTMLMetaElement>('meta[name=pnyx-token]')?.content

    if (!token) {
      return
    }

    const version = ++generation
    const url = new URL(
      '/ws',
      location.href,
    )
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    url.searchParams.set(
      'token',
      token,
    )
    url.searchParams.set(
      'scoped',
      '1',
    )
    url.searchParams.set(
      'subscription',
      crypto.randomUUID(),
    )
    url.searchParams.set(
      'scope',
      selection().creation && selected.startsWith('pending-') ? selection().creation!.from : selected,
    )
    const ws = new WebSocket(url)
    socket = ws
    received = Date.now()

    const recover = () => {
      if (!active || version !== generation || socket !== ws) {
        return
      }

      socket = null
      ws.close()
      disconnected()
      clearTimeout(reconnect)
      reconnect = setTimeout(
        connect,
        reconnectDelay({ attempt: attempt++ }),
      )
    }

    ws.onclose = recover
    ws.onerror = recover

    ws.onmessage = event => {
      if (!active || version !== generation || socket !== ws) {
        return
      }

      received = Date.now()

      try {
        receive({ message: JSON.parse(event.data) as ServerMessage })
      } catch (error) {
        selection().error = error instanceof Error ? error.message : String(error)
        send({
          message: {
            type: 'resync',
            scope: selection().id,
          },
        })
        publish()
      }
    }

    clearInterval(watchdog)
    watchdog = setInterval(
      () => {
        if (Date.now() - received > 25000) {
          recover()
        } else {
          send({ message: { type: 'ping' } })
        }
      },
      10000,
    )
  }

  const navigate = async ({
    url,
    replace = false,
  }: {
    url: string
    replace?: boolean
  }) => {
    const next = new URL(
      url,
      location.href,
    )

    if (next.origin !== origin || !/^\/hydra\/[a-z0-9._-]+\/$/.test(next.pathname)) {
      throw new CommandFailure({
        message: 'Invalid Hydra URL',
        code: 'VALIDATION_ERROR',
      })
    }

    selected = next.pathname.split('/')[2]!
    const scope = selection()

    if (scope.failed) {
      scope.error = ''
    }

    scope.failed = false
    save({
      key: selectedKey,
      value: null,
    })

    if (replace) {
      history.replaceState(
        null,
        '',
        next,
      )
    } else {
      history.pushState(
        null,
        '',
        next,
      )
    }

    staleUpdates()
    publish(); subscribe({ scope })
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
          ...(creation.icon ? { icon: creation.icon } : {}),
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
      selected = id
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

    try {
      const receipt = await command({
        scope: scopeFor({ id: creation.from }),
        name: 'hydras',
        args: [
          'create',
          creation.name,
          creation.attempt,
          ...(creation.icon ? [creation.icon] : []),
        ],
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

  const pop = () => {
    void navigate({
      url: location.href,
      replace: true,
    })
  }

  const persistAll = () => scopes.forEach(scope => persist({ scope }))

  const wake = () => {
    if (document.visibilityState !== 'hidden' && socket?.readyState !== WebSocket.OPEN && active) {
      clearTimeout(reconnect)
      socket?.close()
      connect()
    }
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
    commandFor({ id }: { id: string }) {
      return scopeFor({ id }).command
    },
    navigate,
    create,
    retry() {
      const scope = selection()

      if (scope.creation && scope.id.startsWith('pending-')) {
        void attemptCreation({
          creation: scope.creation,
          choose: true,
        }).catch(() => {})

        return
      }

      scope.failed = false
      scope.error = ''
      scope.subscribed = false
      subscribe({ scope })
      publish()
    },
    start() {
      active = true
      restoreCreations()
      connect()
      addEventListener(
        'popstate',
        pop,
      )
      addEventListener(
        'pagehide',
        persistAll,
      )
      addEventListener(
        'online',
        wake,
      )
      document.addEventListener(
        'visibilitychange',
        wake,
      )

      return () => {
        active = false
        generation++
        clearTimeout(reconnect)
        clearInterval(watchdog)
        persistAll()
        socket?.close()
        socket = null
        disconnected()

        for (const request of requests.values()) {
          clearTimeout(request.timer)
        }

        scopes.forEach(scope => clearTimeout(scope.persistTimer))
        removeEventListener(
          'popstate',
          pop,
        )
        removeEventListener(
          'pagehide',
          persistAll,
        )
        removeEventListener(
          'online',
          wake,
        )
        document.removeEventListener(
          'visibilitychange',
          wake,
        )
      }
    },
  }
}

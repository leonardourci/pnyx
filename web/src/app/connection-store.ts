import type { HydraState } from '#app/model.ts'
import { emptyHydra,reduce } from '#app/reducer.ts'
import { saveEventId,savedReceipt,type SaveCommand } from '#app/save-receipts.ts'
import type { HydraSummary } from '#app/server-hydras.ts'
import type { ServerMessage } from '#app/server-transport.ts'
import { hydraConfig } from '#hydra/config.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import type { HydraQueue } from '#hydra/wakes.ts'
import type { UpgradeStatus } from '#upgrade/model.ts'
import { readSettingsSaves,saveSettingsSaves } from '#web-hydra/outbox.ts'
import { sharedSettings } from '#web-settings/shared-settings.ts'
import { CommandFailure,createPendingResource } from '#web-shared/pending-intents.ts'
import { argument } from '#web-tasks/optimistic.ts'
import { noteUpdate,staleUpdates } from '#web-tasks/updates-cache.ts'
import { DISPATCH_CHANGED } from '#web-workers/heads-dispatch.ts'
import type { Creation,Request,Scope } from './connection-model.ts'
import { reconnectDelay,retainedReadings,withChanges } from './connection-protocol.ts'
import { createConnectionRequests } from './connection-requests.ts'
import { confirmedState,removeStored,save,stored } from './connection-storage.ts'
import { createHydraCreation } from './hydra-creation.ts'
import { log, setLogMode, startPageLog } from './log.ts'
import { pendingHydra } from './pending-state.ts'
import { shouldReload } from './view.ts'

const HEARTBEAT_INTERVAL_MS = 10_000
const RECOVERY_TIMEOUT_MS = 25_000
const TOKEN_REFRESH_TIMEOUT_MS = 5_000
const NO_TOKEN_MESSAGE = 'This page has no connection token. Reload to connect.'
const OTHER_INSTALLATION_MESSAGE =
  'This address now serves another Pnyx installation. Reload to continue.'
const PERMANENT_SCOPE_ERRORS = new Set([
  'NOT_FOUND',
  'VALIDATION_ERROR',
  'FORBIDDEN',
  'UNAUTHORIZED',
  'OWNER_ONLY',
])

const emptyQueue = (): HydraQueue => ({
  waiting: [],
  reading: [],
})

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
  let offline = false
  let reloadError = ''
  let generation = 0
  let attempt = 0
  // The socket's attempts that failed since it was last open; an outage logs once, and the open line after it counts them.
  let failures = 0
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

  // Arrows reach functions declared below; accessors share the live socket, selection and listing.
  const {
    command,
    flush,
    respond,
    disconnectRequests,
  } = createConnectionRequests({
    connection: {
      get socket() {
        return socket
      },
    },
    scopes,
    requests,
    hydras,
    publish: () => publish(),
    subscribe: ({ scope }) => subscribe({ scope }),
    persistSaves: ({ scope }) => persistSaves({ scope }),
    send: ({ message }) => send({ message }),
    updateHydras: ({ rows }) => updateHydras({ rows }),
  })
  const {
    updateHydras,
    attemptCreation,
    create,
    restoreCreations,
  } = createHydraCreation({
    connection: {
      get selected() {
        return selected
      },
      // eslint-disable-next-line pnyx/object-params -- JavaScript setter contract.
      set selected(value) {
        selected = value
      },
      get listed() {
        return listed
      },
      // eslint-disable-next-line pnyx/object-params -- JavaScript setter contract.
      set listed(value) {
        listed = value
      },
    },
    scopes,
    requests,
    creations,
    hydras,
    namespace,
    creationKey,
    selectedKey,
    scopeFor: ({ id }) => scopeFor({ id }),
    selection: () => selection(),
    publish: () => publish(),
    subscribe: ({ scope }) => subscribe({ scope }),
    command,
  })

  const scopeFor = ({ id }: { id: string }): Scope => {
    const existing = scopes.get(id)

    if (existing) {
      return existing
    }

    const summary = hydras.snapshot().view.find(hydra => hydra.id === id)
    const identity = summary?.identity ?? (id === initialId
      ? document.querySelector<HTMLMetaElement>('meta[name=pnyx-hydra]')?.content ?? id : id)
    removeStored({ key: `pnyx:${identity}:hydra-state` })
    const restored = stored({
      key: keyFor({ id }),
      fallback: emptyHydra(),
    })
    const usable = restored?.v === 1 && restored.cards
    const confirmed = usable ? confirmedState({ state: restored }) : emptyHydra()
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
      loadError: '',
      subscriptionAttempt: 0,
      thread: null,
      queue: emptyQueue(),
      spend: {},
      usage: {},
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

  let shown: {
    view: HydraState
    spend: Scope['spend']
    usage: Scope['usage']
    state: HydraState
  } | undefined

  // Live spend and usage join only their own cards, so every other card keeps its identity between publishes.
  const liveView = ({
    scope,
    view,
  }: {
    scope: Scope
    view: HydraState
  }): HydraState => {
    if (shown?.view === view && shown.spend === scope.spend && shown.usage === scope.usage) {
      return shown.state
    }

    const cards = { ...view.cards }

    for (const id of new Set([
      ...Object.keys(scope.spend),
      ...Object.keys(scope.usage),
    ])) {
      const card = view.cards[id]

      if (card) {
        cards[id] = {
          ...card,
          spend: scope.spend[id],
          usage: scope.usage[id],
        }
      }
    }

    shown = {
      view,
      spend: scope.spend,
      usage: scope.usage,
      state: {
        ...view,
        cards,
      },
    }

    return shown.state
  }

  const visible = () => {
    const scope = selection()
    const resource = scope.resource.snapshot()

    let recovery: {
      message: string
      action?: 'reload' | 'retry'
    } | null = null

    if (reloadError) {
      recovery = {
        message: reloadError,
        action: 'reload',
      }
    } else if (scope.creation && scope.failed) {
      recovery = {
        message: scope.error,
        action: 'retry',
      }
    } else if (scope.loadError) {
      recovery = { message: scope.loadError }

      if (scope.failed) {
        recovery.action = 'retry'
      }
    }

    return {
      recovery,
      state: scope.hasSnapshot ? liveView({
        scope,
        view: resource.view,
      }) : shell({ scope }),
      viewKey: scope.viewKey,
      connected: scope.ready && socket?.readyState === WebSocket.OPEN,
      offline,
      loaded: scope.hasSnapshot || scope.failed,
      loading: scope.ready || scope.failed ? '' : scope.id,
      checking: [...requests.values()].some(request => request.scope === scope && request.checking),
      creating: !!scope.creation && scope.id.startsWith('pending-'),
      error: scope.creation && scope.failed ? '' : scope.error,
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
      if (scope.id === selected || scope.id.startsWith('pending-')) {
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

      if (scope.subscribed) {
        send({
          message: {
            type: 'unsubscribe',
            scope: scope.id,
          },
        })
      }

      clearTimeout(scope.subscriptionTimer)
      scope.subscription = null
      scope.subscribed = false
      scope.ready = false
    }
  }

  const retrySubscription = ({ scope }: { scope: Scope }) => {
    clearTimeout(scope.subscriptionTimer)
    scope.ready = false
    scope.subscribed = false
    scope.subscription = null
    scope.failed = false
    scope.subscriptionTimer = setTimeout(
      () => {
        subscribe({ scope })
        publish()
      },
      reconnectDelay({ attempt: scope.subscriptionAttempt++ }),
    )
  }

  const watchSubscription = ({ scope }: { scope: Scope }) => {
    clearTimeout(scope.subscriptionTimer)
    scope.subscriptionTimer = setTimeout(
      () => {
        scope.loadError = 'Hydra did not finish loading. Retrying automatically.'
        retrySubscription({ scope })
        publish()
      },
      RECOVERY_TIMEOUT_MS,
    )
  }

  const subscribe = ({ scope }: { scope: Scope }) => {
    if (scope.id.startsWith('pending-') || scope.subscribed || scope.failed || !physicalHydra || socket?.readyState !== WebSocket.OPEN) {
      return
    }

    scope.subscribed = true
    scope.subscription = crypto.randomUUID()
    scope.ready = false
    scope.actions = {}
    watchSubscription({ scope })
    send({
      message: {
        type: 'subscribe',
        scope: scope.id,
        subscription: scope.subscription,
        ...(scope.hasSnapshot ? { after: String(scope.resource.snapshot().confirmed.seq) } : {}),
      },
    })
  }

  const confirmState = ({
    scope,
    state,
  }: {
    scope: Scope
    state: HydraState
  }) => {
    const before = scope.resource.snapshot().confirmed
    scope.spend = retainedReadings({
      current: scope.spend,
      before,
      after: state,
    })
    scope.usage = retainedReadings({
      current: scope.usage,
      before,
      after: state,
    })
    scope.resource.confirm({ state })
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
        reloadError = OTHER_INSTALLATION_MESSAGE
        clearInterval(watchdog)
        socket?.close()
        publish()

        return
      }

      if (!physicalHydra) {
        physicalHydra = message.scope
        scope.subscribed = true
        scope.subscription = message.subscription ?? null
        watchSubscription({ scope })
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
      clearTimeout(scope.subscriptionTimer)
      scope.loadError = message.error
      scope.failed = PERMANENT_SCOPE_ERRORS.has(message.code)
      scope.ready = false
      scope.subscribed = false

      if (!scope.failed) {
        scope.loadError = `${message.error}. Retrying automatically.`
        retrySubscription({ scope })
      }
    } else if (message.type === 'snapshot') {
      confirmState({
        scope,
        state: confirmedState({ state: message.state }),
      })
      scope.actions = {}
      scope.hasSnapshot = true
      confirmSaves({ scope })
      // The shown queue stays until the one the server sends after every snapshot arrives.

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
        watchSubscription({ scope })
        send({
          message: {
            type: 'resync',
            scope: scope.id,
          },
        })
        publish()

        return
      }

      confirmState({
        scope,
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
      scope.spend = withChanges({
        current: scope.spend,
        changes: message.spend ?? {},
      })
      scope.usage = withChanges({
        current: scope.usage,
        changes: message.usage ?? {},
      })

      scope.latest = withChanges({
        current: scope.latest,
        changes: message.messages,
      })
      scope.actions = withChanges({
        current: scope.ready ? scope.actions : {},
        changes: message.actions,
      })
      const wasReady = scope.ready
      clearTimeout(scope.subscriptionTimer)
      scope.subscriptionAttempt = 0
      scope.loadError = ''
      scope.ready = true
      scope.failed = false
      attempt = 0

      if (!wasReady) {
        window.dispatchEvent(new Event(DISPATCH_CHANGED))

        if (scope.id === physicalHydra || scope.id === selected) {
          command({
            scope,
            name: 'hydras',
            args: [],
          }).catch((error: Error) => {
            if (error instanceof CommandFailure && error.code === 'DISCONNECTED') {
              // The next subscription reloads this catalog.
              return
            }

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
    } else if (message.type === 'settings') {
      setLogMode({ mode: message.settings.logs })
      sharedSettings().receive({
        state: {
          settings: message.settings,
          revision: message.revision,
        },
      })
    } else if ('id' in message && message.id) {
      respond({
        scope,
        id: message.id,
        message,
      })

      return
    }

    publish(); flush()
  }

  const disconnected = () => {
    physicalHydra = null
    listed = false

    for (const scope of scopes.values()) {
      clearTimeout(scope.subscriptionTimer)
      scope.ready = false; scope.subscribed = false; scope.subscription = null
      scope.actions = {}
    }

    disconnectRequests()

    publish()
  }

  const connect = () => {
    if (!active) {
      return
    }

    const token = document.querySelector<HTMLMetaElement>('meta[name=pnyx-token]')?.content

    if (!token) {
      reloadError = NO_TOKEN_MESSAGE
      publish()

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
    let opened = false
    socket = ws
    received = Date.now()
    const started = received
    const connecting = performance.now()

    const recover = () => {
      if (!active || version !== generation || socket !== ws) {
        return
      }

      socket = null
      clearInterval(watchdog)
      offline = true
      ws.close()
      failures += opened ? 0 : 1

      if (opened || failures === 1) {
        log({
          operation: 'page.socket',
          status: opened ? 'lost' : 'failed',
        })
      }

      disconnected()
      clearTimeout(reconnect)
      reconnect = setTimeout(
        async () => {
          if (!opened) {
            try {
              const response = await fetch(
                location.href,
                {
                  cache: 'no-store',
                  signal: AbortSignal.timeout(TOKEN_REFRESH_TIMEOUT_MS),
                },
              )

              if (active && version === generation && response.ok) {
                const page = new DOMParser().parseFromString(
                  await response.text(),
                  'text/html',
                )
                const identity = page.querySelector<HTMLMetaElement>('meta[name=pnyx-installation]')?.content
                const refreshed = page.querySelector<HTMLMetaElement>('meta[name=pnyx-token]')?.content

                if (!active || version !== generation) {
                  return
                }

                if (identity === installation && refreshed) {
                  document.querySelector<HTMLMetaElement>('meta[name=pnyx-token]')?.setAttribute(
                    'content',
                    refreshed,
                  )
                } else {
                  active = false
                  reloadError = NO_TOKEN_MESSAGE

                  if (identity && identity !== installation) {
                    reloadError = OTHER_INSTALLATION_MESSAGE
                  }

                  publish()

                  return
                }
              }
            } catch {
              // An unavailable page uses the same automatic backoff as its socket.
            }
          }

          if (active && version === generation) {
            connect()
          }
        },
        reconnectDelay({ attempt: attempt++ }),
      )
    }

    ws.onclose = recover
    ws.onerror = recover

    ws.onopen = () => {
      if (!active || version !== generation || socket !== ws) {
        return
      }

      opened = true
      offline = false
      reloadError = ''
      log({
        operation: 'page.socket',
        status: 'open',
        ms: performance.now() - connecting,
        count: failures || undefined,
      })
      failures = 0
      publish()
    }

    ws.onmessage = event => {
      if (!active || version !== generation || socket !== ws) {
        return
      }

      received = Date.now()
      const handling = performance.now()

      try {
        const message = JSON.parse(event.data) as ServerMessage
        receive({ message })
        // A snapshot replaces the whole Hydra, so each one gets a line; other messages are live updates. The server's socket.send line has their size.
        log({
          operation: message.type === 'snapshot' ? 'page.snapshot' : 'page.update',
          detailed: message.type !== 'snapshot',
          hydraId: message.scope,
          name: message.type,
          ms: performance.now() - handling,
        })
      } catch (error) {
        const scope = selection()
        scope.loadError = error instanceof Error ? error.message : String(error)
        scope.ready = false
        watchSubscription({ scope })
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
        const now = Date.now()
        const handshakeStalled = !physicalHydra && now - started > RECOVERY_TIMEOUT_MS

        if (now - received > RECOVERY_TIMEOUT_MS || handshakeStalled) {
          recover()
        } else {
          send({ message: { type: 'ping' } })
        }
      },
      HEARTBEAT_INTERVAL_MS,
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
      scope.loadError = ''
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

  const pop = () => {
    void navigate({
      url: location.href,
      replace: true,
    })
  }

  const persistAll = () => scopes.forEach(scope => persist({ scope }))

  const wake = () => {
    if (!active || document.visibilityState === 'hidden') {
      return
    }

    const stale = Date.now() - received > RECOVERY_TIMEOUT_MS

    if (socket?.readyState === WebSocket.OPEN && !stale) {
      send({ message: { type: 'ping' } })

      return
    }

    clearTimeout(reconnect)
    generation++
    const previous = socket
    socket = null
    previous?.close()
    disconnected()
    connect()
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
      scope.loadError = ''
      scope.subscribed = false
      subscribe({ scope })
      publish()
    },
    dismissError() {
      selection().error = ''
      publish()
    },
    start() {
      active = true
      const stopLog = startPageLog({
        send: ({ lines }) => {
          if (socket?.readyState !== WebSocket.OPEN) {
            return false
          }

          socket.send(`{"type":"log","lines":[${lines.join(',')}]}`)

          return true
        },
        hydra: () => selected,
      })
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
        'pageshow',
        wake,
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
          'pageshow',
          wake,
        )
        removeEventListener(
          'online',
          wake,
        )
        document.removeEventListener(
          'visibilitychange',
          wake,
        )
        stopLog()
      }
    },
  }
}

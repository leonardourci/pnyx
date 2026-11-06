import { removeStored } from './connection-storage.ts'
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
import { reconnectDelay,withChanges } from './connection-protocol.ts'
import { createConnectionRequests } from './connection-requests.ts'
import { save,stored } from './connection-storage.ts'
import { createHydraCreation } from './hydra-creation.ts'
import { pendingHydra } from './pending-state.ts'
import { shouldReload } from './view.ts'

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

  const visible = () => {
    const scope = selection()
    const resource = scope.resource.snapshot()

    return {
      state: scope.hasSnapshot ? {
        ...resource.view,
        cards: Object.fromEntries(Object.entries(resource.view.cards).map(([
          id,
          card,
        ]) => [
          id,
          {
            ...card,
            spend: scope.spend[id],
            usage: scope.usage[id],
          },
        ])),
      } : shell({ scope }),
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
    scope.actions = {}
    send({
      message: {
        type: 'subscribe',
        scope: scope.id,
        subscription: scope.subscription,
        ...(scope.hasSnapshot ? { after: String(scope.resource.snapshot().confirmed.seq) } : {}),
      },
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
      scope.actions = {}
      scope.spend = {}
      scope.usage = {}
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
    } else if (message.type === 'settings') {
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

import { withDefaults } from '#settings/settings.ts'
import { createThreadReceiver } from '#titan/thread-receive.ts'
import type { TitanState } from '#app/model.ts'
import type { TitanSummary } from '#app/server-hydras.ts'
import { emptyTitan } from '#app/reducer.ts'
import { saveEventId,savedReply,type SaveCommand } from '#app/save-receipts.ts'
import type { ServerMessage } from '#app/server-transport.ts'
import { hydraConfig } from '#titan/config.ts'
import { TITAN_CARD } from '#titan/identity.ts'
import type { TitanQueue } from '#titan/wakes.ts'
import type { UpgradeStatus } from '#upgrade/model.ts'
import { readSavedCommands,saveCommands } from '#web-titan/outbox.ts'
import { sharedSettings } from '#web-settings/shared-settings.ts'
import { CommandFailure,createPendingResource } from '#web-shared/pending-intents.ts'
import { DISPATCH_CHANGED } from '#web-workers/heads-dispatch.ts'
import { createPendingTurns, pendingTurns } from '#web-workers/pending-turns.ts'
import type { Creation,Request,Scope } from './connection-model.ts'
import { reconnectDelay,retainedReadings,withChanges } from './connection-protocol.ts'
import { createConnectionRequests } from './connection-requests.ts'
import { dropSnapshots, save } from './connection-storage.ts'
import { createTitanCreation } from './hydra-creation.ts'
import { applyPageChanges, pageChanges, type HomePage } from '#app/socket-state.ts'
import type { SocketCursor } from '#app/socket-history.ts'
import { log, setLogMode, startPageLog, takeFrames } from './log.ts'
import { pendingTitan } from './pending-state.ts'
import { shouldReload } from './view.ts'

const HEARTBEAT_INTERVAL_MS = 10_000
const RECOVERY_TIMEOUT_MS = 25_000
const TOKEN_REFRESH_TIMEOUT_MS = 5_000
const NO_TOKEN_MESSAGE = 'This page has no connection token. Reload to connect.'
const OTHER_INSTALLATION_MESSAGE =
  'This address now serves another Othrys installation. Reload to continue.'
const PERMANENT_SCOPE_ERRORS = new Set([
  'NOT_FOUND',
  'VALIDATION_ERROR',
  'FORBIDDEN',
  'UNAUTHORIZED',
  'OWNER_ONLY',
])

const emptyQueue = (): TitanQueue => ({
  waiting: [],
  reading: [],
})

export function createTitanConnection() {
  const origin = location.origin
  const installation = document.querySelector<HTMLMetaElement>('meta[name=othrys-installation]')?.content
    ?? document.querySelector<HTMLMetaElement>('meta[name=othrys-hydra]')?.content ?? ''
  const namespace = `${origin}:${installation}`
  const initialId = location.pathname.split('/')[2] ?? 'default'
  const scopes = new Map<string, Scope>()
  const requests = new Map<string, Request>()
  const listeners = new Set<() => void>()
  const creationKey = `othrys:${namespace}:hydra-creations`
  const selectedKey = `othrys:${namespace}:selected-creation`
  const creations = new Map<string, Creation>()
  let selected = initialId
  let socket: WebSocket | null = null
  let physicalTitan: string | null = null
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
  let home: HomePage | undefined
  let homeCursor: SocketCursor | undefined
  let homeReady = false
  let watchdog: ReturnType<typeof setInterval> | undefined
  let staleSince: number | undefined

  const hydras = createPendingResource<TitanSummary[], TitanSummary>({
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
    updateTitans: ({ rows }) => updateTitans({ rows }),
  })
  const {
    updateTitans,
    attemptCreation,
    create,
    restoreCreations,
  } = createTitanCreation({
    connection: {
      get selected() {
        return selected
      },
      // eslint-disable-next-line othrys/object-params -- JavaScript setter contract.
      set selected(value) {
        selected = value
      },
      get listed() {
        return listed
      },
      // eslint-disable-next-line othrys/object-params -- JavaScript setter contract.
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
      ? document.querySelector<HTMLMetaElement>('meta[name=othrys-hydra]')?.content ?? id : id)
    const threads = createThreadReceiver()
    const scope: Scope = {
      id,
      identity,
      viewKey: id,
      resource: pendingTitan({
        scope: `${namespace}/hydra/${id}/`,
        confirmed: emptyTitan(),
      }),
      turns: createPendingTurns({ scope: `${namespace}/hydra/${id}/turns` }),
      hasSnapshot: false,
      ready: false,
      subscribed: false,
      subscription: null,
      failed: false,
      restoredSaves: false,
      error: '',
      loadError: '',
      subscriptionAttempt: 0,
      threads,
      get thread() {
        return threads.read({ card: TITAN_CARD })
      },
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
      }) => {
        if (name === 'page') {
          scope.page = args
          scope.threads.retain({
            cards: args.filter((
              _,
              index,
            ) => args[index - 1] === '--card'),
          })
          // Losing this send is safe: every subscribe sends scope.page again.
          command({
            scope,
            name,
            args,
          }).catch(() => {})

          return openCards({
            scope,
            refs: args.filter((
              _,
              index,
            ) => args[index - 1] === '--card'),
          })
        }

        return command({
          scope,
          name,
          args,
          onChecking,
        })
      },
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

  const shell = ({ scope }: { scope: Scope }): TitanState => {
    const state = emptyTitan()
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

  const shown = new Map<string, {
    view: TitanState
    spend: Scope['spend']
    usage: Scope['usage']
    state: TitanState
  }>()

  // Live spend and usage join only their own cards, so every other card keeps its identity between publishes.
  const liveView = ({
    scope,
    view,
  }: {
    scope: Scope
    view: TitanState
  }): TitanState => {
    const previous = shown.get(scope.id)
    const sameReadings = previous !== undefined && previous.spend === scope.spend
      && previous.usage === scope.usage

    if (sameReadings && previous.view === view) {
      return previous.state
    }

    const sameCards = sameReadings && previous.view.cards === view.cards
    const cards = sameCards ? previous.state.cards : { ...view.cards }

    if (!sameCards) {
      for (const id of new Set([
        ...Object.keys(scope.spend),
        ...Object.keys(scope.usage),
      ])) {
        const card = view.cards[id]

        if (card) {
          const cached = previous?.state.cards[id]
          const unchanged = previous?.view.cards[id] === card
            && previous?.spend[id] === scope.spend[id] && previous?.usage[id] === scope.usage[id]
          cards[id] = cached && unchanged ? cached : {
            ...card,
            spend: scope.spend[id],
            usage: scope.usage[id],
          }
        }
      }
    }

    const next = {
      view,
      spend: scope.spend,
      usage: scope.usage,
      state: {
        ...view,
        cards,
      },
    }

    shown.set(
      scope.id,
      next,
    )

    return next.state
  }

  const visible = ({ scope = selection() }: { scope?: Scope } = {}) => {
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
      storageTitan: scope.identity,
      connected: scope.ready && socket?.readyState === WebSocket.OPEN
        && homeReady
        && resource.confirmed.seq >= (scope.expectedSeq ?? 0),
      offline,
      loaded: scope.hasSnapshot || scope.failed,
      loading: scope.ready || scope.failed ? '' : scope.id,
      checking: [...requests.values()].some(request => request.scope === scope && request.checking),
      creating: !!scope.creation && scope.id.startsWith('pending-'),
      error: scope.creation && scope.failed ? '' : scope.error,
      hydraThread: scope.thread,
      taskThreads: Object.fromEntries((scope.page ?? []).filter((
        _,
        index,
        args,
      ) => args[index - 1] === '--card')
        .map(ref => {
          const id = resource.view.keys[ref] ?? ref

          return [
            id,
            scope.threads.read({ card: id }),
          ]
        })),
      hydraQueue: scope.queue,
      upgrade,
      latest: scope.latest,
      actions: scope.actions,
      pendingTurns: pendingTurns({
        resource: scope.turns,
        hydraStatus: resource.confirmed.hydraStatus,
      }),
      navigation: {
        titanId: scope.id,
        page: scope.id === selected && (location.pathname.endsWith('/settings/') || new URLSearchParams(location.search).has('settings')) ? 'settings' : 'hydra',
        hydras: hydras.snapshot().view.map(hydra => {
          const preview = scopes.get(hydra.id)?.resource.snapshot().view.config

          return preview ? {
            ...hydra,
            name: preview.name,
            polis: preview.polis ?? 'shared',
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
    document.querySelector<HTMLMetaElement>('meta[name=othrys-hydra]')?.setAttribute(
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
        const error = failed?.error ?? intent?.error ?? new CommandFailure({
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

  const saveCommand = ({ request }: { request: Request }): SaveCommand => ({
    type: 'command',
    id: request.id,
    name: request.name,
    args: request.args,
  })

  const persistSaves = ({ scope }: { scope: Scope }) => {
    const commands = [...requests.values()]
      .filter(request => request.scope === scope && (request.name === 'hydra-agent'
        || request.name === 'hydra' && request.args[0] === 'send' && !!request.saveId))
      .map(request => saveCommand({ request }))
    const ids = new Set(commands.map(command => saveEventId({command})))
    const retained = scope.restoredSaves ? [] : readSavedCommands({titanId: scope.identity})
      .filter(command => !ids.has(saveEventId({command})))
    saveCommands({
      titanId: scope.identity,
      commands: [
        ...retained,
        ...commands,
      ],
    })
  }

  const confirmSaves = ({ scope }: { scope: Scope }) => {
    for (const request of requests.values()) {
      if (request.scope !== scope || (!request.saveId && !request.optimistic)) {
        continue
      }

      const state = scope.resource.snapshot().confirmed
      // The page keeps no event ids, so a Titan message or agent change confirms only from its receipt.
      const receipt = savedReply({
        command: saveCommand({ request }),
        state,
      })

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
      const displayed = hydras.snapshot().view.some(hydra => hydra.id === scope.id)

      if (displayed || scope.id === selected || scope.id.startsWith('pending-')) {
        continue
      }

      if (scope.id === physicalTitan && !listed) {
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
        scope.loadError = 'Titan did not finish loading. Retrying automatically.'
        retrySubscription({ scope })
        publish()
      },
      RECOVERY_TIMEOUT_MS,
    )
  }

  const markStale = () => {
    if (staleSince !== undefined || ![...scopes.values()].some(scope => scope.hasSnapshot)) {
      return
    }

    staleSince = performance.now()
    log({
      operation: 'page.recovery',
      status: 'stale',
      titanId: selected,
      eventSeq: selection().resource.snapshot().confirmed.seq,
    })
  }

  const reconcileReads = () => {
    if (staleSince === undefined || !homeReady || !physicalTitan) {
      return
    }

    const waiting = [...scopes.values()].some(scope => scope.subscribed
      && (!scope.ready || !scope.hasSnapshot
        || scope.resource.snapshot().confirmed.seq < (scope.expectedSeq ?? 0)))

    if (waiting) {
      return
    }

    log({
      operation: 'page.recovery',
      status: 'reconciled',
      titanId: selected,
      eventSeq: selection().resource.snapshot().confirmed.seq,
      ms: performance.now() - staleSince,
    })
    staleSince = undefined
  }

  // A card the page is still creating has no row yet, so it is on its way rather than missing.
  const openCards = async ({
    scope,
    refs,
  }: {
    scope: Scope
    refs: string[]
  }) => {
    const shown = scope.resource.snapshot().view

    return {
      unavailable: refs.filter(ref => !shown.cards[ref] && !shown.keys[ref]),
    }
  }

  const subscribe = ({ scope }: { scope: Scope }) => {
    if (scope.id.startsWith('pending-') || scope.subscribed || scope.failed || !physicalTitan || socket?.readyState !== WebSocket.OPEN) {
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
        // JSON drops an undefined page, so a scope that opened no cards sends none.
        page: scope.page,
      },
    })
  }

  const receiveState = ({
    scope,
    state,
  }: {
    scope: Scope
    state: TitanState
  }) => {
    const handling = performance.now()
    const first = !scope.hasSnapshot
    confirmState({
      scope,
      state,
    })
    scope.hasSnapshot = true

    if (scope.ready) {
      clearTimeout(scope.subscriptionTimer)
      scope.loadError = ''
    }

    reconcileReads()

    confirmSaves({ scope })
    publish(); flush()
    log({
      operation: 'page.update',
      detailed: !first,
      titanId: scope.id,
      name: 'socket',
      ms: performance.now() - handling,
    })
  }

  const confirmState = ({
    scope,
    state,
  }: {
    scope: Scope
    state: TitanState
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
    scope.turns.confirm({ state: state.cards })
  }

  const receive = ({ message }: { message: ServerMessage }) => {
    if (message.type === 'home.snapshot' || message.type === 'home.delta' || message.type === 'home.ready') {
      const previous = home

      if (message.type === 'home.snapshot') {
        if (previous) {
          const changes = pageChanges({
            before: previous,
            after: message.home,
          })
          home = changes ? applyPageChanges({
            before: previous,
            changes,
          }) : previous
        } else {
          home = message.home
        }

        homeCursor = message.cursor
      } else if (message.type === 'home.delta' && home && homeCursor
        && homeCursor.epoch === message.cursor.epoch && homeCursor.seq + 1 === message.cursor.seq) {
        home = applyPageChanges({
          before: home,
          changes: message.changes,
        })
        homeCursor = message.cursor
      } else if (message.type === 'home.ready' && homeCursor
        && homeCursor.epoch === message.cursor.epoch && homeCursor.seq === message.cursor.seq) {
        homeReady = true
        reconcileReads()
        publish()

        return
      } else {
        homeCursor = undefined
        homeReady = false
        socket?.close()

        return
      }

      if (home) {
        updateTitans({ rows: home.hydras })
        setLogMode({ mode: home.settings.settings.logs })
        sharedSettings().receive({
          state: {
            settings: withDefaults({ stored: home.settings.settings }),
            revision: home.settings.revision,
          },
        })
        upgrade = home.upgrade ?? undefined

        for (const [
          id,
          page,
        ] of Object.entries(home.scopes)) {
          const scope = scopeFor({ id })

          if (previous?.scopes[id]?.state !== page.state || !scope.hasSnapshot) {
            scope.queue = page.queue
            receiveState({
              scope,
              state: {
                ...emptyTitan(),
                ...page.state,
              },
            })
          } else if (previous.scopes[id]?.queue !== page.queue) {
            scope.queue = page.queue
          }

          subscribe({ scope })
        }
      }

      publish()

      return
    }

    if (message.type === 'pong') {
      return
    }

    if (!message.scope) {
      return
    }

    const scope = scopeFor({ id: message.scope })
    const response = 'id' in message && !!message.id

    if (physicalTitan && !response && scope.subscription !== message.subscription) {
      return
    }

    if (!scope.subscribed && !response && message.type !== 'hello') {
      return
    }

    if (message.type === 'hello' && physicalTitan && !scope.subscribed) {
      return
    }

    const normalized = scope.threads.receive({ message })

    if (!normalized) {
      send({
        message: {
          type: 'resync',
          scope: scope.id,
        },
      })

      return
    }

    message = normalized

    if (message.type === 'thread') {
      publish(); flush()

      return
    }

    if (message.type === 'hello') {
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

      if (!physicalTitan) {
        physicalTitan = scope.id
        scope.subscribed = true
        scope.subscription = message.subscription ?? null
        watchSubscription({ scope })
        subscribe({ scope: selection() })

        for (const hydra of hydras.snapshot().view) {
          subscribe({ scope: scopeFor({ id: hydra.id }) })
        }

        for (const request of requests.values()) {
          subscribe({ scope: request.scope })
        }
      }

      scope.expectedSeq = message.stateSeq
      scope.identity = message.titanId

      if (!scope.restoredSaves) {
        for (const saved of readSavedCommands({ titanId: scope.identity })) {
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

        scope.restoredSaves = true
        persistSaves({scope})
      }

      if (shouldReload({
        loaded: document.querySelector<HTMLMetaElement>('meta[name=othrys-build]')?.content,
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

      if (scope.hasSnapshot) {
        clearTimeout(scope.subscriptionTimer)
        scope.loadError = ''
      }

      scope.subscriptionAttempt = 0
      scope.ready = true
      reconcileReads()
      scope.failed = false
      attempt = 0

      if (!wasReady) {
        window.dispatchEvent(new Event(DISPATCH_CHANGED))
      }
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
    markStale()
    physicalTitan = null
    listed = false
    homeReady = false

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

    const token = document.querySelector<HTMLMetaElement>('meta[name=othrys-token]')?.content

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
    url.searchParams.set(
      'home',
      '1',
    )

    if (homeCursor) {
      url.searchParams.set(
        'cursor',
        JSON.stringify(homeCursor),
      )
    }

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
    const primary = selection().creation && selected.startsWith('pending-') ? selection().creation!.from : selected
    url.searchParams.set(
      'scope',
      primary,
    )
    const page = scopes.get(primary)?.page

    if (page) {
      url.searchParams.set(
        'page',
        JSON.stringify(page),
      )
    }

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
                const identity = page.querySelector<HTMLMetaElement>('meta[name=othrys-installation]')?.content
                const refreshed = page.querySelector<HTMLMetaElement>('meta[name=othrys-token]')?.content

                if (!active || version !== generation) {
                  return
                }

                if (identity === installation && refreshed) {
                  document.querySelector<HTMLMetaElement>('meta[name=othrys-token]')?.setAttribute(
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
        // The attempts that failed before this open, when the socket had been down.
        count: failures > 0 ? failures : undefined,
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
        // Each line carries the reveal frames drawn since the last; the server's socket.send line has their size.
        const drawn = takeFrames()
        log({
          operation: 'page.update',
          detailed: true,
          titanId: message.scope,
          name: message.type,
          ms: performance.now() - handling,
          frames: drawn.frames,
          worstFrameMs: drawn.worstFrameMs,
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
        const handshakeStalled = !physicalTitan && now - started > RECOVERY_TIMEOUT_MS

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

    if (next.origin !== origin || !/^\/hydra\/[a-z0-9._-]+\/(?:settings\/)?$/.test(next.pathname)) {
      throw new CommandFailure({
        message: 'Invalid Titan URL',
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

    publish(); subscribe({ scope })
  }

  const pop = () => {
    void navigate({
      url: location.href,
      replace: true,
    })
  }

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
    workspaces: () => {
      const ids = new Set([
        selected,
        ...hydras.snapshot().view.map(hydra => hydra.id),
      ])

      return [...ids].map(id => visible({ scope: scopeFor({ id }) }))
    },
    // eslint-disable-next-line othrys/object-params -- React useSyncExternalStore subscription contract.
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
      dropSnapshots()
      const stopLog = startPageLog({
        send: ({ lines }) => {
          if (socket?.readyState !== WebSocket.OPEN) {
            return false
          }

          socket.send(`{"type":"log","lines":[${lines.join(',')}]}`)

          return true
        },
        hydra: () => selected,
        chat: () => {
          let chars = 0, messages = 0

          for (const scope of scopes.values()) {
            if (scope.thread) {
              chars += JSON.stringify(scope.thread).length
              messages += scope.thread.entries.length
            }
          }

          return {
            chars,
            messages,
          }
        },
      })
      restoreCreations()
      connect()
      addEventListener(
        'popstate',
        pop,
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
        // First, so what the page queued goes out while its socket is still open.
        stopLog()
        active = false
        generation++
        clearTimeout(reconnect)
        clearInterval(watchdog)
        socket?.close()
        socket = null
        disconnected()

        for (const request of requests.values()) {
          clearTimeout(request.timer)
        }

        removeEventListener(
          'popstate',
          pop,
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
      }
    },
  }
}

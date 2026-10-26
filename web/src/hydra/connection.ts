import { reminderTime } from '../../../src/reminders/time.ts'
import { optimisticState, currentRevision } from './optimistic.ts'
import { CommandFailure } from './pending-intents.ts'
import { commandArguments, editTargets, pendingHydra } from './pending-state.ts'
import { DISPATCH_CHANGED } from './heads-dispatch.ts'
import { CLONE_TIMEOUT_MS } from '../../../src/projects/limits.ts'
import { readSettingsSaves, saveSettingsSaves, storageKey } from './outbox.ts'
import { saveEventId, savedReceipt, type SaveCommand } from '../../../src/server/saves.ts'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { HYDRA_CARD } from '../../../src/core/hydra.ts'
import type { HydraState } from '../../../src/core/model.ts'
import { emptyHydra, reduce } from '../../../src/core/reducer.ts'
import type { ServerMessage } from '../../../src/server/server.ts'
import type { HydraSummary } from '../../../src/server/hydras.ts'
import type { HydraQueue } from '../../../src/server/host.ts'
import type { LatestMessage, ThreadPage } from '../../../src/thread/read.ts'
import type { CurrentAction } from '../../../src/thread/calls.ts'
import { shouldReload } from './view.ts'
import { noteUpdate, staleUpdates } from './updates-cache.ts'

const EMPTY_QUEUE: HydraQueue = {
  waiting: [],
  reading: [],
}

export type Receipt = Record<string, unknown>
export type Command = ({
  name,
  args,
  onChecking,
}: {
  name: string
  args: string[]
  onChecking?(): void
}) => Promise<Receipt>

const cacheKey = () => storageKey({ key: 'hydra-state' })
export const reconnectDelay = ({ attempt }: { attempt: number }) =>
  Math.min(
    500 * 2 ** Math.min(
      attempt,
      5,
    ),
    10000,
  )
export const retryable = ({
  name,
  args,
}: {
  name: string
  args: string[]
}) =>
  [
    'reply',
    'task-message',
    'answer',
    'agent',
    'hydra-agent',
  ].includes(name) || (name === 'hydra' && args[0] === 'send' && args.includes('--event-id'))

export function commandTimeout({
  name,
  args,
}: {
  name: string
  args: string[]
}): number {
  if (name === 'project' && args[0] === 'add' && args.includes('--clone')) {
    return CLONE_TIMEOUT_MS + 20_000
  }

  return [
    'reply',
    'task-message',
    'answer',
    'agent',
  ].includes(name) ? 140000 : 60000
}

function restoredHydra(): HydraState {
  try {
    const state = JSON.parse(sessionStorage.getItem(cacheKey()) ?? 'null') as HydraState | null

    return state?.v === 1 && typeof state.seq === 'number' && state.cards ? state : emptyHydra()
  } catch {
    return emptyHydra()
  }
}

// A push carries only the cards that changed; null drops a card's value.
export function withChanges<Value>({
  current,
  changes,
}: {
  current: Record<string, Value>
  changes: Record<string, Value | null>
}): Record<string, Value> {
  const next = { ...current }

  for (const [
    card,
    value,
  ] of Object.entries(changes)) {
    if (value) {
      next[card] = value
    } else {
      delete next[card]
    }
  }

  return next
}

export function useHydra() {
  const [
    endpoint,
    setEndpoint,
  ] = useState(location.href)
  const [
    loading,
    setLoading,
  ] = useState('')
  const [
    loaded,
    setLoaded,
  ] = useState(false)
  const [
    error,
    setError,
  ] = useState('')
  const target = useRef(location.href)
  const [
    checking,
    setChecking,
  ] = useState(false)
  const cache = useRef(new Map<string, {
    identity: string
    state: HydraState
    hydraThread: ThreadPage | null
    latest: Record<string, LatestMessage>
    actions: Record<string, CurrentAction>
  }>())
  const [
    state,
    setState,
  ] = useState<HydraState>(restoredHydra)
  const [
    connected,
    setConnected,
  ] = useState(false)
  const [
    navigation,
    setNavigation,
  ] = useState<{
    hydraId: string
    hydras: HydraSummary[]
  }>({
    hydraId: location.pathname.split('/')[2] ?? 'default',
    hydras: [],
  })
  const [
    hydraThread,
    setHydraThread,
  ] = useState<ThreadPage | null>(null)
  const [
    latest,
    setLatest,
  ] = useState<Record<string, LatestMessage>>({})
  const [
    actions,
    setActions,
  ] = useState<Record<string, CurrentAction>>({})
  const [
    hydraQueue,
    setHydraQueue,
  ] = useState<HydraQueue>(EMPTY_QUEUE)
  const identity = useRef(document.querySelector<HTMLMetaElement>('meta[name=pnyx-hydra]')?.content ?? '')
  const initial = useRef({
    endpoint: location.href,
    state,
  })
  const resource = useMemo(
    () => pendingHydra({
      scope: new URL(endpoint).origin + new URL(endpoint).pathname,
      confirmed: endpoint === initial.current.endpoint ? initial.current.state : emptyHydra(),
    }),
    [endpoint],
  )
  const pendingState = useSyncExternalStore(
    resource.subscribe,
    resource.snapshot,
  )
  const socket = useRef<WebSocket | null>(null)
  const hasSnapshot = useRef(false)
  const ready = useRef(false)
  const pending = useRef(new Map<string, {
    resolve({ receipt }: { receipt: Receipt }): void
    reject({ error }: { error: Error }): void
    timer?: ReturnType<typeof setTimeout>
    message: SaveCommand
    sent: boolean
    retry: boolean
    optimistic: boolean
    settled: Promise<void>
    saveId?: string
    checking?: boolean
    unconfirmed(): void
  }>())
  const persistSaves = useCallback(
    () => {
      saveSettingsSaves({
        hydraId: identity.current,
        commands: [...pending.current.values()].filter(p => p.message.name === 'hydra-agent').map(p => p.message),
      })
    },
    [],
  )
  const publishChecking = useCallback(
    () => {
      setChecking([...pending.current.values()].some(p => p.checking))
    },
    [],
  )
  const confirmSaves = useCallback(
    () => {
      let confirmed = false

      for (const [
        id,
        p,
      ] of pending.current) {
        const receipt = savedReceipt({
          command: p.message,
          state: resource.snapshot().confirmed,
        })

        if (receipt) {
          clearTimeout(p.timer)
          pending.current.delete(id)
          p.resolve({ receipt })
          confirmed = true
        }
      }

      if (confirmed) {
        persistSaves()
        publishChecking()
      }
    },
    [
      persistSaves,
      publishChecking,
      resource,
    ],
  )
  const publish = useCallback(
    () => {
      const active = new URL(target.current).pathname === new URL(endpoint).pathname

      for (const intent of resource.snapshot().intents) {
        const p = pending.current.get(intent.id)

        if (p && intent.stage === 'refused' && intent.error) {
          pending.current.delete(intent.id); clearTimeout(p.timer)
          p.reject({ error: intent.error })

          if (active) {
            setError(intent.error.message)
          }
        }
      }

      if (!active) {
        return
      }

      setState(resource.snapshot().view)
    },
    [
      endpoint,
      resource,
    ],
  )
  const flushRef = useRef<() => void>(() => {})
  const flush = useCallback(
    () => {
      if (!ready.current || socket.current?.readyState !== WebSocket.OPEN) {
        return
      }

      let editing = [...pending.current.values()].some(p => p.sent && p.optimistic)
        || resource.snapshot().intents.some(intent => intent.stage === 'accepted')

      for (const [
        id,
        p,
      ] of pending.current) {
        if (p.optimistic && resource.snapshot().intents.some(intent => intent.id === id && intent.stage === 'refused')) {
          continue
        }

        if (p.sent || (p.optimistic && editing)) {
          continue
        }

        if (p.optimistic) {
          editing = true
          p.message.args = currentRevision({
            state: resource.snapshot().confirmed,
            edit: p.message,
          })
        }

        p.sent = true

        if (p.optimistic) {
          resource.sending({ id })
        }

        p.timer = setTimeout(
          () => {
            const error = new CommandFailure({
              message: 'Send could not be confirmed. Draft kept; check the conversation before retrying.',
              code: 'TIMEOUT',
              outcome: 'unknown',
            })

            if (p.saveId) {
              p.checking = true
              p.unconfirmed()
              publishChecking()
              p.sent = false
              flushRef.current()

              return
            }

            if (p.optimistic) {
              resource.unknown({
                id,
                error,
              })
              socket.current?.close()
              publish()

              return
            }

            pending.current.delete(id)
            publish(); setError('Save could not be confirmed. Check the Hydra before retrying.')
            p.reject({ error })
            flushRef.current()
          },
          commandTimeout({
            name: p.message.name,
            args: p.message.args,
          }),
        )
        socket.current.send(JSON.stringify(p.message))
      }
    },
    [
      publish,
      publishChecking,
      resource,
    ],
  )
  flushRef.current = flush
  const disconnected = useCallback(
    () => {
      ready.current = false
      setConnected(false)

      for (const [
        id,
        p,
      ] of pending.current) {
        clearTimeout(p.timer)

        if (p.optimistic && p.sent) {
          resource.unknown({
            id,
            error: new CommandFailure({
              message: 'Connection lost before confirmation.',
              code: 'DISCONNECTED',
              outcome: 'unknown',
            }),
          })
        }

        if (p.retry) {
          p.sent = false

          if (p.saveId) {
            p.checking = true
            p.unconfirmed()
          }
        } else {
          pending.current.delete(id)
          p.reject({
            error: new CommandFailure({
              message: 'Could not confirm this action. Check its outcome before retrying.',
              code: 'DISCONNECTED',
              outcome: 'unknown',
            }),
          })
        }
      }

      publish()
      publishChecking()
    },
    [
      publish,
      publishChecking,
      resource,
    ],
  )
  useEffect(
    () => {
      const pathname = new URL(endpoint).pathname
      setChecking(false)
      const saved = cache.current.get(pathname)

      if (!resource.snapshot().confirmed.config) {
        resource.confirm({
          state: saved?.state
          ?? (endpoint === initial.current.endpoint ? initial.current.state : emptyHydra()),
        })
      }

      hasSnapshot.current = !!saved
      identity.current = saved?.identity ?? identity.current
      let closed = false, retry: ReturnType<typeof setTimeout> | undefined
      let attempt = 0, received = Date.now()
      let watchdog: ReturnType<typeof setInterval> | undefined
      let persistTimer: ReturnType<typeof setTimeout> | undefined

      const persist = () => {
        try {
          sessionStorage.setItem(
            `pnyx:${identity.current}:hydra-state`,
            JSON.stringify(resource.snapshot().confirmed),
          )
        } catch { /* A full or blocked store still permits reconnect in this tab. */ }
      }

      addEventListener(
        'pagehide',
        persist,
      )

      const cacheThread = ({ page }: { page: ThreadPage }) => {
        const entry = cache.current.get(pathname)

        if (entry && page.card === HYDRA_CARD) {
          entry.hydraThread = page
        }
      }

      const connect = () => {
        const token = document.querySelector<HTMLMetaElement>('meta[name=pnyx-token]')?.content

        if (!token) {
          return
        }

        const url = new URL(
          'ws',
          endpoint,
        ); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'; url.searchParams.set(
          'token',
          token,
        )

        if (hasSnapshot.current) {
          url.searchParams.set(
            'after',
            String(resource.snapshot().confirmed.seq),
          )
        }

        const ws = new WebSocket(url); socket.current = ws
        received = Date.now()
        clearInterval(watchdog)

        const recover = () => {
          if (closed || socket.current !== ws) {
            return
          }

          socket.current = null
          clearInterval(watchdog)
          ws.close()
          disconnected()

          if (!hasSnapshot.current) {
            setError('Could not load Hydra. Retrying…')
          }

          retry = setTimeout(
            connect,
            reconnectDelay({ attempt: attempt++ }),
          )
        }

        watchdog = setInterval(
          () => {
            if (Date.now() - received > 25000) {
              recover()
            } else if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'ping' }))
            }
          },
          10000,
        )
        ws.onclose = recover
        ws.onerror = recover

        ws.onmessage = e => {
          if (closed || socket.current !== ws) {
            return
          }

          try {
            received = Date.now()
            const m = JSON.parse(e.data) as ServerMessage
            const active = new URL(target.current).pathname === pathname

            if (m.type === 'hello') {
              identity.current = m.hydraId

              for (const message of readSettingsSaves({ hydraId: m.hydraId })) {
                if (!pending.current.has(message.id)) {
                  pending.current.set(
                    message.id,
                    {
                      message,
                      saveId: saveEventId({ command: message }),
                      resolve: () => {},
                      reject: () => {},
                      unconfirmed: () => {},
                      settled: Promise.resolve(),
                      sent: false,
                      checking: true,
                      retry: true,
                      optimistic: false,
                    },
                  )
                }
              }

              publishChecking()

              if (active) {
                document.querySelector<HTMLMetaElement>('meta[name=pnyx-hydra]')
                  ?.setAttribute(
                    'content',
                    m.hydraId,
                  )
              }

              if (shouldReload({
                loaded: document.querySelector<HTMLMetaElement>('meta[name=pnyx-build]')?.content,
                server: m.build,
              })) {
                closed = true; ws.close(); location.reload()
              }
            } else if (m.type === 'snapshot') {
              hasSnapshot.current = true; resource.confirm({ state: m.state })
              confirmSaves()
              staleUpdates()

              // The server follows a snapshot with Hydra's queue only when it holds updates.
              if (active) {
                setHydraQueue(EMPTY_QUEUE)
              }

              const previous = cache.current.get(pathname)
              cache.current.set(
                pathname,
                {
                  identity: identity.current,
                  state: m.state,
                  hydraThread: previous?.hydraThread ?? null,
                  latest: previous?.latest ?? {},
                  actions: previous?.actions ?? {},
                },
              )
              publish(); setLoaded(true)

              if (active) {
                setNavigation(old => ({
                  ...old,
                  hydraId: pathname.split('/')[2] ?? m.state.config?.id ?? 'default',
                }))
              }

              clearTimeout(persistTimer); persistTimer = setTimeout(
                persist,
                250,
              )
            } else if (m.type === 'event') {
              if (m.event.seq <= resource.snapshot().confirmed.seq) {
                return
              }

              if (m.event.seq !== resource.snapshot().confirmed.seq + 1) {
                ready.current = false; setConnected(false)
                ws.send(JSON.stringify({ type: 'resync' }))

                return
              }

              resource.confirm({
                state: reduce({
                  state: resource.snapshot().confirmed,
                  event: m.event,
                }),
              })
              confirmSaves()
              noteUpdate({ event: m.event })
              const entry = cache.current.get(pathname)

              if (entry) {
                entry.state = resource.snapshot().confirmed
              }

              publish(); flush()
              clearTimeout(persistTimer); persistTimer = setTimeout(
                persist,
                250,
              )
            } else if (m.type === 'thread') {
              cacheThread({ page: m.thread })

              if (!active) {
                return
              }

              if (m.thread.card === HYDRA_CARD) {
                setHydraThread(m.thread)
              }
            } else if (m.type === 'latest') {
              if (m.spend) {
                const cards = { ...resource.snapshot().confirmed.cards }

                for (const [
                  id,
                  spend,
                ] of Object.entries(m.spend)) {
                  if (cards[id]) {
                    cards[id] = {
                      ...cards[id],
                      spend,
                    }
                  }
                }

                resource.confirm({
                  state: {
                    ...resource.snapshot().confirmed,
                    cards,
                  },
                })
                publish()
              }

              if (!ready.current) {
                ready.current = true; attempt = 0; flush()

                if (active) {
                  setConnected(true); setLoading(''); setLoaded(true)
                  setError(current => current.startsWith('Could not load Hydra.') ? '' : current)
                }

                window.dispatchEvent(new Event(DISPATCH_CHANGED))
              }

              const entry = cache.current.get(pathname)
              const next = withChanges({
                current: entry?.latest ?? {},
                changes: m.messages,
              })
              const nextActions = withChanges({
                current: entry?.actions ?? {},
                changes: m.actions,
              })

              if (entry) {
                entry.state = resource.snapshot().confirmed
                entry.latest = next
                entry.actions = nextActions
              }

              if (active) {
                setLatest(next)
                setActions(nextActions)
              }
            } else if (m.type === 'hydraQueue') {
              if (active) {
                setHydraQueue(m.queue)
              }
            } else if (m.type === 'hydras') {
              setNavigation(old => ({
                ...old,
                ...(active ? { hydraId: m.hydraId } : {}),
                hydras: m.hydras,
              }))
            } else if ('id' in m && m.id) {
              const p = pending.current.get(m.id)

              if (!p) {
                return
              }

              if (m.type === 'error' && p.saveId && m.saved !== false) {
                p.checking = true
                p.unconfirmed()
                publishChecking()

                return
              }

              clearTimeout(p.timer); pending.current.delete(m.id)

              if (p.message.name === 'hydra-agent') {
                persistSaves()
              }

              publishChecking()

              if (m.type === 'error') {
                const error = new CommandFailure({
                  message: m.error,
                  code: m.code,
                  help: m.help,
                })

                if (p.optimistic) {
                  resource.refuse({
                    id: m.id,
                    error,
                  })
                  setError(m.error)
                }

                p.reject({ error })
              } else {
                if (p.optimistic) {
                  resource.accept({
                    id: m.id,
                    complete: m.event === 'none: unchanged',
                  })
                }

                if (p.message.name === 'hydras' && typeof m.hydraId === 'string' && Array.isArray(m.hydras)) {
                  setNavigation(old => ({
                    ...old,
                    hydras: m.hydras as HydraSummary[],
                  }))
                }

                if ([
                  'rule',
                  'account',
                ].includes(p.message.name) && ![
                  'list',
                  undefined,
                ].includes(p.message.args[0])) {
                  window.dispatchEvent(new Event(DISPATCH_CHANGED))
                }

                if (p.message.name === 'thread' && m.thread) {
                  cacheThread({ page: m.thread as ThreadPage })
                }

                p.resolve({ receipt: m })
              }

              publish(); flush()
            }
          } catch {
            ws.send(JSON.stringify({ type: 'resync' }))
          }
        }
      }

      const wake = () => {
        if (document.visibilityState === 'hidden' || socket.current?.readyState === WebSocket.OPEN) {
          return
        }

        clearTimeout(retry)
        socket.current?.close()
        connect()
      }

      addEventListener(
        'online',
        wake,
      )
      document.addEventListener(
        'visibilitychange',
        wake,
      )
      connect()

      return () => {
        persist(); removeEventListener(
          'pagehide',
          persist,
        ); clearTimeout(persistTimer)
        closed = true; clearTimeout(retry); clearInterval(watchdog); socket.current?.close()
        removeEventListener(
          'online',
          wake,
        )
        document.removeEventListener(
          'visibilitychange',
          wake,
        )
        disconnected()

        for (const [
          id,
          p,
        ] of pending.current) {
          clearTimeout(p.timer)

          if (p.optimistic) {
            resource.unknown({
              id,
              error: new CommandFailure({
                message: 'Send interrupted. Check its outcome before retrying.',
                code: 'INTERRUPTED',
                outcome: 'unknown',
              }),
            })
          }

          if (!p.saveId) {
            p.reject({
              error: new CommandFailure({
                message: 'Send interrupted. Draft kept.',
                code: 'INTERRUPTED',
                outcome: 'unknown',
              }),
            })
          }
        }

        pending.current.clear()
      }
    },
    [
      disconnected,
      flush,
      publish,
      endpoint,
      confirmSaves,
      persistSaves,
      publishChecking,
      resource,
    ],
  )
  const command: Command = useCallback(
    ({
      name,
      args,
      onChecking,
    }) => new Promise((
      resolve,
      reject,
    ) => {
      const retry = retryable({
        name,
        args,
      })

      const switching = new URL(target.current).pathname !== new URL(endpoint).pathname
      const offline = !ready.current || socket.current?.readyState !== WebSocket.OPEN

      if (switching || (offline && !retry)) {
        reject(new Error('Could not complete this action. Try again.'))

        return
      }

      if (!document.querySelector<HTMLMetaElement>('meta[name=pnyx-token]')?.content) {
        reject(new Error('Open this Hydra through pnyx-axi serve to send. Draft kept.'))

        return
      }

      if (name === 'task' && args[0] === 'remind' && args[2] !== 'clear') {
        args = [...args]
        args[2] = reminderTime({
          when: args[2] ?? '',
          now: new Date().toISOString(),
        })
      }

      const id = crypto.randomUUID()
      const message: SaveCommand = {
        type: 'command',
        id,
        name,
        args,
      }
      const confirmed = savedReceipt({
        command: message,
        state: resource.snapshot().confirmed,
      })

      if (confirmed) {
        resolve(confirmed)

        return
      }

      let optimistic: boolean

      try {
        const visible = resource.snapshot().view
        optimistic = optimisticState({
          state: visible,
          edit: {
            name,
            args,
          },
        }) !== visible
      } catch (error) {
        reject(error)

        return
      }

      try {
        args = commandArguments({
          id,
          edit: {
            name,
            args,
          },
          persisted: optimistic,
        })
      } catch (error) {
        reject(error)

        return
      }

      if (optimistic) {
        const edit = {
          name,
          args,
        }
        const targets = editTargets({ edit })
        const dependencies = resource.snapshot().intents.filter(intent =>
          ![
            'refused',
            'confirmed',
          ].includes(intent.stage)
          && intent.patch.name === 'column' && intent.patch.args[0] === 'create'
          && (targets.some(target => intent.targets.includes(target))
            || args.some(arg => intent.targets.includes(arg))))
          .map(intent => intent.id)

        resource.enqueue({
          id,
          targets,
          patch: edit,
          dependencies,
          delivery: 'idempotent',
        })
      }

      message.args = args

      let settle = () => {}
      const settled = new Promise<void>(resolve => {
        settle = resolve
      })
      pending.current.set(
        id,
        {
          resolve: ({ receipt }) => {
            resolve(receipt); settle()
          },
          reject: ({ error }) => {
            reject(error); settle()
          },
          settled,
          message,
          saveId: saveEventId({ command: message }),
          unconfirmed: () => {
            onChecking?.()
            settle()
          },
          retry: retry || optimistic,
          optimistic,
          sent: false,
        },
      )

      if (name === 'hydra-agent') {
        persistSaves()
      }

      publish(); flush()
    }),
    [
      flush,
      publish,
      endpoint,
      persistSaves,
      resource,
    ],
  )

  const navigate = useCallback(
    async ({
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

      if (next.origin !== location.origin || !/^\/hydra\/[a-z0-9._-]+\/$/.test(next.pathname)) {
        throw new Error('Invalid Hydra URL')
      }

      const previous = new URL(endpoint).pathname

      if (next.pathname === previous) {
        target.current = endpoint
        document.querySelector<HTMLMetaElement>('meta[name=pnyx-hydra]')
          ?.setAttribute(
            'content',
            identity.current,
          )
        publish(); setLoading(''); setConnected(ready.current)
        const previousView = cache.current.get(previous)

        if (previousView) {
          setHydraThread(previousView.hydraThread)
          setLatest(previousView.latest)
          setActions(previousView.actions)
        }

        setNavigation(old => ({
          ...old,
          hydraId: previous.split('/')[2] ?? old.hydraId,
        }))
        history.replaceState(
          null,
          '',
          next,
        )

        return
      }

      target.current = next.href
      setLoading(next.pathname.split('/')[2]!); setError('')
      // The next Hydra's server sends its own queue once connected.
      setHydraQueue(EMPTY_QUEUE)
      const saved = cache.current.get(next.pathname)

      if (saved) {
        document.querySelector<HTMLMetaElement>('meta[name=pnyx-hydra]')
          ?.setAttribute(
            'content',
            saved.identity,
          )
        setState(saved.state)
        setHydraThread(saved.hydraThread); setLatest(saved.latest); setActions(saved.actions)
        setNavigation(old => ({
          ...old,
          hydraId: next.pathname.split('/')[2]!,
        }))
      }

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

      // A switch must not interrupt a save or deliver it to the next Hydra.
      await Promise.allSettled([...pending.current.values()].map(p => p.settled))

      if (target.current !== next.href) {
        return
      }

      document.querySelector('base')?.setAttribute(
        'href',
        next.pathname,
      )

      if (!saved) {
        setHydraThread(null); setLatest({}); setActions({})
      }

      setConnected(false)
      setEndpoint(next.href)
    },
    [
      endpoint,
      publish,
    ],
  )
  const navigateRef = useRef(navigate)
  navigateRef.current = navigate
  useEffect(
    () => {
      const pop = () => {
        void navigateRef.current({
          url: location.href,
          replace: true,
        })
      }

      addEventListener(
        'popstate',
        pop,
      )

      return () => removeEventListener(
        'popstate',
        pop,
      )
    },
    [],
  )

  return {
    state: new URL(target.current).pathname === new URL(endpoint).pathname
      ? pendingState.view : state,
    connected: connected && !loading,
    command,
    hydraThread,
    hydraQueue,
    latest,
    actions,
    navigation: {
      ...navigation,
      hydras: navigation.hydras.map(h => h.id === state.config?.id
        ? {
          ...h,
          name: state.config.name,
        } : h),
    },
    navigate,
    loading,
    loaded,
    error,
    checking,
    intents: new URL(target.current).pathname === new URL(endpoint).pathname
      ? pendingState.intents : [],
  }
}

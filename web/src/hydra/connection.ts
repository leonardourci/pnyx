import { reminderTime } from '../../../src/reminders/time.ts'
import { optimisticState, currentRevision, projectEdits } from './optimistic.ts'
import { DISPATCH_CHANGED } from './heads-dispatch.ts'
import { commandBytes, MAX_MESSAGE_BYTES } from '../../../src/server/protocol.ts'
import { CLONE_TIMEOUT_MS } from '../../../src/projects/limits.ts'
import { storageKey } from './outbox.ts'
import { useCallback, useEffect, useRef, useState } from 'react'
import { HYDRA_CARD } from '../../../src/core/hydra.ts'
import type { HydraState } from '../../../src/core/model.ts'
import { emptyHydra, reduce } from '../../../src/core/reducer.ts'
import type { ServerMessage } from '../../../src/server/server.ts'
import type { HydraSummary } from '../../../src/server/hydras.ts'
import type { LatestMessage, ThreadPage } from '../../../src/thread/read.ts'
import type { CurrentAction } from '../../../src/thread/calls.ts'
import { shouldReload } from './view.ts'

export type Receipt = Record<string, unknown>
export type Command = ({
  name,
  args,
}: {
  name: string
  args: string[]
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
function withChanges<Value>({
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
  const cache = useRef(new Map<string, {
    identity: string
    state: HydraState
    hydraThread: ThreadPage | null
    latest: Record<string, LatestMessage>
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
  // What each card's agent is running now; live only, so it is not kept when switching Hydras.
  const [
    actions,
    setActions,
  ] = useState<Record<string, CurrentAction>>({})
  const identity = useRef(document.querySelector<HTMLMetaElement>('meta[name=pnyx-hydra]')?.content ?? '')
  const initial = useRef({
    endpoint: location.href,
    state,
  })
  const stateRef = useRef(state)
  const socket = useRef<WebSocket | null>(null)
  const hasSnapshot = useRef(false)
  const ready = useRef(false)
  const pending = useRef(new Map<string, {
    resolve({ receipt }: { receipt: Receipt }): void
    reject({ error }: { error: Error }): void
    timer?: ReturnType<typeof setTimeout>
    message: {
      type: 'command'
      id: string
      name: string
      args: string[]
    }
    sent: boolean
    retry: boolean
    optimistic: boolean
    settled: Promise<void>
  }>())
  const publish = useCallback(
    () => {
      if (new URL(target.current).pathname !== new URL(endpoint).pathname) {
        return
      }

      setState(projectEdits({
        state: stateRef.current,
        edits: [...pending.current.values()].filter(p => p.optimistic).map(p => p.message),
        invalid: ({
          edit,
          error,
        }) => {
          for (const [
            id,
            p,
          ] of pending.current) {
            if (p.message === edit) {
              pending.current.delete(id); clearTimeout(p.timer)
              p.reject({ error }); setError(error.message)
            }
          }
        },
      }))
    },
    [endpoint],
  )
  const flushRef = useRef<() => void>(() => {})
  const flush = useCallback(
    () => {
      if (!ready.current || socket.current?.readyState !== WebSocket.OPEN) {
        return
      }

      let editing = [...pending.current.values()].some(p => p.sent && p.optimistic)

      for (const [
        id,
        p,
      ] of pending.current) {
        if (p.sent || (p.optimistic && editing)) {
          continue
        }

        if (p.optimistic) {
          editing = true
          p.message.args = currentRevision({
            state: stateRef.current,
            edit: p.message,
          })
        }

        p.sent = true
        p.timer = setTimeout(
          () => {
            pending.current.delete(id)
            publish(); setError('Save could not be confirmed. Check the Hydra before retrying.')
            p.reject({ error: new Error('Send could not be confirmed. Draft kept; check the conversation before retrying.') })
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
    [publish],
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

        if (p.retry) {
          p.sent = false
        } else {
          pending.current.delete(id)
          p.reject({ error: new Error('Could not complete this action. Try again.') })
        }
      }

      publish()
    },
    [publish],
  )
  useEffect(
    () => {
      const pathname = new URL(endpoint).pathname
      const saved = cache.current.get(pathname)
      stateRef.current = saved?.state
      ?? (endpoint === initial.current.endpoint ? initial.current.state : emptyHydra())
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
            JSON.stringify(stateRef.current),
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
            String(stateRef.current.seq),
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
              hasSnapshot.current = true; stateRef.current = m.state
              const previous = cache.current.get(pathname)
              cache.current.set(
                pathname,
                {
                  identity: identity.current,
                  state: m.state,
                  hydraThread: previous?.hydraThread ?? null,
                  latest: previous?.latest ?? {},
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
              if (m.event.seq <= stateRef.current.seq) {
                return
              }

              if (m.event.seq !== stateRef.current.seq + 1) {
                ready.current = false; setConnected(false)
                ws.send(JSON.stringify({ type: 'resync' }))

                return
              }

              stateRef.current = reduce({
                state: stateRef.current,
                event: m.event,
              })
              const entry = cache.current.get(pathname)

              if (entry) {
                entry.state = stateRef.current
              }

              publish()
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

              if (entry) {
                entry.latest = next
              }

              if (active) {
                setLatest(next)
                setActions(current => withChanges({
                  current,
                  changes: m.actions,
                }))
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

              clearTimeout(p.timer); pending.current.delete(m.id)

              if (m.type === 'error') {
                if (p.optimistic) {
                  setError(m.error)
                }

                p.reject({ error: new Error(m.error) })
              } else {
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

        for (const p of pending.current.values()) {
          p.reject({ error: new Error('Send interrupted. Draft kept.') })
        }

        pending.current.clear()
      }
    },
    [
      disconnected,
      flush,
      publish,
      endpoint,
    ],
  )
  const command: Command = useCallback(
    ({
      name,
      args,
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

      if (commandBytes({
        id,
        name,
        args,
      }) > MAX_MESSAGE_BYTES) {
        reject(new Error('Message exceeds the 64 KiB limit. Shorten the draft or file contents. Draft kept.'))

        return
      }

      let optimistic: boolean

      try {
        const visible = projectEdits({
          state: stateRef.current,
          edits: [...pending.current.values()].filter(p => p.optimistic).map(p => p.message),
        })
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
          message: {
            type: 'command',
            id,
            name,
            args,
          },
          retry,
          optimistic,
          sent: false,
        },
      )
      publish(); flush()
    }),
    [
      flush,
      publish,
      endpoint,
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
        }

        setActions({})

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
      const saved = cache.current.get(next.pathname)

      if (saved) {
        document.querySelector<HTMLMetaElement>('meta[name=pnyx-hydra]')
          ?.setAttribute(
            'content',
            saved.identity,
          )
        setState(saved.state)
        setHydraThread(saved.hydraThread); setLatest(saved.latest); setActions({})
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
    state,
    connected: connected && !loading,
    command,
    hydraThread,
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
  }
}

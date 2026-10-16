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
import { shouldReload } from './view.ts'

export type Receipt = Record<string, unknown>
export type Command = ({ name, args }: { name: string; args: string[] }) => Promise<Receipt>

const CACHE_KEY = storageKey({ key: 'hydra-state' })
export const reconnectDelay = ({ attempt }: { attempt: number }) =>
  Math.min(500 * 2 ** Math.min(attempt, 5), 10000)
export const retryable = ({ name, args }: { name: string; args: string[] }) =>
  ['reply', 'answer', 'agent'].includes(name) || (name === 'hydra' && args[0] === 'send' && args.includes('--event-id'))

export function commandTimeout({ name, args }: { name: string; args: string[] }): number {
  if (name === 'project' && args[0] === 'add' && args.includes('--clone')) {
    return CLONE_TIMEOUT_MS + 20_000
  }

  return ['reply', 'answer', 'agent'].includes(name) ? 140000 : 60000
}

function restoredHydra(): HydraState {
  try {
    const state = JSON.parse(sessionStorage.getItem(CACHE_KEY) ?? 'null') as HydraState | null

    return state?.v === 1 && typeof state.seq === 'number' && state.cards ? state : emptyHydra()
  } catch {
    return emptyHydra()
  }
}

export function useHydra() {
  const [state, setState] = useState<HydraState>(restoredHydra)
  const [connected, setConnected] = useState(false)
  const [navigation, setNavigation] = useState<{ hydraId: string; hydras: HydraSummary[] }>({
    hydraId: document.querySelector<HTMLMetaElement>('meta[name=pnyx-hydra]')?.content ?? 'default',
    hydras: [],
  })
  const [thread, setThread] = useState<ThreadPage | null>(null)
  const [hydraThread, setHydraThread] = useState<ThreadPage | null>(null)
  const [latest, setLatest] = useState<Record<string, LatestMessage>>({})
  const stateRef = useRef(state)
  const socket = useRef<WebSocket | null>(null)
  const hasSnapshot = useRef(false)
  const ready = useRef(false)
  const pending = useRef(new Map<string, {
    resolve({ receipt }: { receipt: Receipt }): void
    reject({ error }: { error: Error }): void
    timer?: ReturnType<typeof setTimeout>
    message: { type: 'command'; id: string; name: string; args: string[] }
    sent: boolean
    retry: boolean
  }>())
  const flush = useCallback(() => {
    if (!ready.current || socket.current?.readyState !== WebSocket.OPEN) {
      return
    }

    for (const [id, p] of pending.current) {
      if (p.sent) {
        continue
      }

      p.sent = true
      p.timer = setTimeout(() => {
        pending.current.delete(id)
        p.reject({ error: new Error('Send could not be confirmed. Draft kept; check the conversation before retrying.') })
      }, commandTimeout({ name: p.message.name, args: p.message.args }))
      socket.current.send(JSON.stringify(p.message))
    }
  }, [])
  const disconnected = useCallback(() => {
    ready.current = false
    setConnected(false)

    for (const [id, p] of pending.current) {
      clearTimeout(p.timer)

      if (p.retry) {
        p.sent = false
      } else {
        pending.current.delete(id)
        p.reject({ error: new Error('Could not complete this action. Try again.') })
      }
    }
  }, [])
  useEffect(() => {
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify(state))
    } catch { /* A full or blocked store still permits reconnect in this tab. */ }
  }, [state])
  useEffect(() => {
    let closed = false, retry: ReturnType<typeof setTimeout> | undefined
    let attempt = 0, received = Date.now()
    let watchdog: ReturnType<typeof setInterval> | undefined

    const connect = () => {
      const token = document.querySelector<HTMLMetaElement>('meta[name=pnyx-token]')?.content

      if (!token) {
        return
      }

      const url = new URL('ws', document.baseURI); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'; url.searchParams.set('token', token)

      if (hasSnapshot.current) {
        url.searchParams.set('after', String(stateRef.current.seq))
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
        retry = setTimeout(connect, reconnectDelay({ attempt: attempt++ }))
      }

      watchdog = setInterval(() => {
        if (Date.now() - received > 25000) {
          recover()
        } else if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }))
        }
      }, 10000)
      ws.onclose = recover
      ws.onerror = recover

      ws.onmessage = e => {
        if (closed || socket.current !== ws) {
          return
        }

        try {
          received = Date.now()
          const m = JSON.parse(e.data) as ServerMessage

          if (m.type === 'hello') {
            if (m.hydraId !== document.querySelector<HTMLMetaElement>('meta[name=pnyx-hydra]')?.content || shouldReload({ loaded: document.querySelector<HTMLMetaElement>('meta[name=pnyx-build]')?.content, server: m.build })) {
              closed = true; ws.close(); location.reload()
            }
          } else if (m.type === 'snapshot') {
            hasSnapshot.current = true; stateRef.current = m.state; setState(m.state); setLatest({})
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
            }); setState(stateRef.current)
          } else if (m.type === 'thread') {
            if (m.thread.card === HYDRA_CARD) {
              setHydraThread(m.thread)
            } else {
              setThread(m.thread)
            }
          } else if (m.type === 'latest') {
            if (!ready.current) {
              ready.current = true; attempt = 0; setConnected(true); flush()
            }

            setLatest(old => {
              const next = { ...old }

              for (const [card, message] of Object.entries(m.messages)) {
                if (message) {
                  next[card] = message
                } else {
                  delete next[card]
                }
              }

              return next
            })
          } else if (m.type === 'hydras') {
            setNavigation({ hydraId: m.hydraId, hydras: m.hydras })
          } else if ('id' in m && m.id) {
            const p = pending.current.get(m.id)

            if (!p) {
              return
            }

            clearTimeout(p.timer); pending.current.delete(m.id)

            if (m.type === 'error') {
              p.reject({ error: new Error(m.error) })
            } else {
              if (p.message.name === 'hydras' && typeof m.hydraId === 'string' && Array.isArray(m.hydras)) {
                setNavigation({ hydraId: m.hydraId, hydras: m.hydras as HydraSummary[] })
              }

              p.resolve({ receipt: m })
            }
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

    addEventListener('online', wake)
    document.addEventListener('visibilitychange', wake)
    connect()

    return () => {
      closed = true; clearTimeout(retry); clearInterval(watchdog); socket.current?.close()
      removeEventListener('online', wake)
      document.removeEventListener('visibilitychange', wake)
      disconnected()

      for (const p of pending.current.values()) {
        p.reject({ error: new Error('Send interrupted. Draft kept.') })
      }

      pending.current.clear()
    }
  }, [disconnected, flush])
  const command: Command = useCallback(({ name, args }) => new Promise((resolve, reject) => {
    const retry = retryable({ name, args })

    if ((!ready.current || socket.current?.readyState !== WebSocket.OPEN) && !retry) {
      reject(new Error('Could not complete this action. Try again.'))

      return
    }

    if (!document.querySelector<HTMLMetaElement>('meta[name=pnyx-token]')?.content) {
      reject(new Error('Open this Hydra through pnyx-axi serve to send. Draft kept.'))

      return
    }

    const id = crypto.randomUUID()

    if (commandBytes({ id, name, args }) > MAX_MESSAGE_BYTES) {
      reject(new Error('Message exceeds the 64 KiB limit. Shorten the draft or file contents. Draft kept.'))

      return
    }

    pending.current.set(id, {
      resolve: ({ receipt }) => resolve(receipt),
      reject: ({ error }) => reject(error),
      message: { type: 'command', id, name, args },
      retry,
      sent: false,
    })
    flush()
  }), [flush])

  return { state, connected, command, thread, setThread, hydraThread, latest, navigation }
}

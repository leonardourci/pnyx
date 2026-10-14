import { useCallback, useEffect, useRef, useState } from 'react'
import type { BoardState } from '../../../src/core/model.ts'
import { emptyBoard, reduce } from '../../../src/core/reducer.ts'
import type { ServerMessage } from '../../../src/server/server.ts'
import type { ThreadPage } from '../../../src/thread/read.ts'

export type Receipt = Record<string, unknown>
export type Command = (name: string, args: string[]) => Promise<Receipt>

export function useBoard() {
  const [state, setState] = useState<BoardState>(emptyBoard), [connected, setConnected] = useState(false), [error, setError] = useState('')
  const [thread, setThread] = useState<ThreadPage | null>(null)
  const stateRef = useRef(state), socket = useRef<WebSocket | null>(null), hasSnapshot = useRef(false)
  const pending = useRef(new Map<string, { resolve(r: Receipt): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }>())
  const rejectPending = useCallback(() => {
    for (const p of pending.current.values()) {
      clearTimeout(p.timer); p.reject(new Error('Connection lost. Check receipts before retrying; draft retained.'))
    }

    pending.current.clear()
  }, [])
  useEffect(() => {
    let closed = false, retry: ReturnType<typeof setTimeout>

    const connect = () => {
      const token = document.querySelector<HTMLMetaElement>('meta[name=pnyx-token]')?.content

      if (!token) {
        setError('Open this board through pnyx-axi serve to connect.')

        return
      }

      const url = new URL('/ws', location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'; url.searchParams.set('token', token)

      if (hasSnapshot.current) {
        url.searchParams.set('after', String(stateRef.current.seq))
      }

      const ws = new WebSocket(url); socket.current = ws

      ws.onopen = () => {
        if (!closed) {
          setConnected(true); setError('')
        }
      }

      ws.onmessage = e => {
        if (closed) {
          return
        }

        try {
          const m = JSON.parse(e.data) as ServerMessage

          if (m.type === 'snapshot') {
            hasSnapshot.current = true; stateRef.current = m.state; setState(m.state)
          } else if (m.type === 'event') {
            if (m.event.seq <= stateRef.current.seq) {
              return
            }

            if (m.event.seq !== stateRef.current.seq + 1) {
              ws.send(JSON.stringify({ type: 'resync' }))

              return
            }

            stateRef.current = reduce(stateRef.current, m.event); setState(stateRef.current)
          } else if (m.type === 'thread') {
            setThread(m.thread)
          } else if (m.type === 'error' && !m.id) {
            setError(m.error)
          } else if (m.id) {
            const p = pending.current.get(m.id)

            if (!p) {
              return
            }

            clearTimeout(p.timer); pending.current.delete(m.id)

            if (m.type === 'error') {
              p.reject(new Error(m.error))
            } else {
              p.resolve(m)
            }
          }
        } catch {
          setError('Could not read a board update.'); ws.send(JSON.stringify({ type: 'resync' }))
        }
      }

      ws.onclose = () => {
        if (!closed) {
          setConnected(false); rejectPending(); retry = setTimeout(connect, 1500)
        }
      }

      ws.onerror = () => {
        if (!closed) {
          setError('Connection unavailable. Reconnecting…')
        }
      }
    }

    connect()

    return () => {
      closed = true; clearTimeout(retry); socket.current?.close(); rejectPending()
    }
  }, [rejectPending])
  const command: Command = useCallback((name, args) => new Promise((resolve, reject) => {
    if (socket.current?.readyState !== WebSocket.OPEN) {
      reject(new Error('The board is offline. Draft retained.'))

      return
    }

    const id = crypto.randomUUID()
    const timer = setTimeout(() => {
      pending.current.delete(id); reject(new Error('No receipt yet. Check history before retrying.'))
    }, name === 'reply' ? 140000 : 15000)
    pending.current.set(id, { resolve, reject, timer })
    socket.current.send(JSON.stringify({ type: 'command', id, name, args }))
  }), [])

  return { state, connected, error, command, thread, setThread }
}

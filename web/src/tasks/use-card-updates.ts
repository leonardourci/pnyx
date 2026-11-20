import { useEffect, useRef, useState } from 'react'
import type { Command } from '#web-app/connection.ts'
import { UPDATES_PAGE } from '#tasks/updates.ts'
import { withNewest, withOlder, type UpdatesList, type UpdatesRead } from './updates-paging.ts'

const LIVE_REFRESH_DEBOUNCE_MS = 300

export type CardUpdates = {
  list: UpdatesList | undefined
  loading: boolean
  error: string | undefined
  retry(): void
}

export function useCardUpdates({
  task,
  command,
  connected,
  through,
}: {
  task: string
  command: Command
  connected: boolean
  through: number
}): CardUpdates {
  const [
    held,
    setHeld,
  ] = useState<{
    task: string
    list?: UpdatesList
  }>({ task })
  const [
    error,
    setError,
  ] = useState<string>()
  const [
    loading,
    setLoading,
  ] = useState(true)
  const [
    attempt,
    setAttempt,
  ] = useState(0)
  const list = held.task === task ? held.list : undefined
  const latest = useRef(held)

  const read = async ({ before }: { before?: number }) => {
    const args = [
      'updates',
      task,
      '--limit',
      String(UPDATES_PAGE),
    ]

    if (before !== undefined) {
      args.push(
        '--before',
        String(before),
      )
    }

    const receipt = await command({
      name: 'task',
      args,
    })
    const page = receipt as unknown as UpdatesRead

    if (before !== undefined && page.older !== undefined && page.older >= before) {
      throw new Error('The update history cursor did not advance')
    }

    return page
  }

  useEffect(
    () => {
      if (!connected) {
        return
      }

      let cancelled = false
      const previous = latest.current.task === task ? latest.current.list : undefined

      const publish = ({ list }: { list: UpdatesList }) => {
        const history = {
          task,
          list,
        }
        latest.current = history
        setHeld(history)
      }

      const loadHistory = async () => {
        try {
          let page = await read({})
          const newestHeld = previous?.events[0]?.seq

          while (!cancelled && page.older !== undefined && newestHeld !== undefined
            && (page.events.at(-1)?.seq ?? 0) > newestHeld) {
            const older = await read({ before: page.older })
            page = {
              events: [
                ...page.events,
                ...older.events,
              ],
              older: older.older,
            }
          }

          if (cancelled) {
            return
          }

          let history = withNewest({
            list: previous,
            read: page,
          })
          publish({ list: history })

          while (history.older !== undefined) {
            const older = await read({ before: history.older })

            if (cancelled) {
              return
            }

            history = withOlder({
              list: history,
              read: older,
            })
            publish({ list: history })
          }
        } catch (failure) {
          if (!cancelled) {
            setError((failure as Error).message)
          }
        } finally {
          if (!cancelled) {
            setLoading(false)
          }
        }
      }

      setError(undefined)
      setLoading(true)
      const timer = setTimeout(
        loadHistory,
        previous ? LIVE_REFRESH_DEBOUNCE_MS : 0,
      )

      return () => {
        cancelled = true
        clearTimeout(timer)
      }
    },
    [
      task,
      through,
      connected,
      attempt,
    ],
  )

  return {
    list,
    loading,
    error,
    retry: () => {
      setError(undefined)
      setLoading(true)
      setAttempt(count => count + 1)
    },
  }
}

import { useEffect, useRef, useState } from 'react'
import type { Command } from '#web-app/connection.ts'
import { UPDATES_PAGE } from '#tasks/updates.ts'
import { withNewest, withOlder, type UpdatesList, type UpdatesRead } from './updates-paging.ts'

// How long a burst of changes waits before the newest page is read again.
const REFRESH_MS = 300

export type CardUpdates = {
  list: UpdatesList | undefined
  loading: boolean
  error: string | undefined
  // Reads the page after the last one held; does nothing while a read is on its way or nothing is older.
  loadOlder(): Promise<void>
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
  // The card's revision changes only when its own facts change.
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
  const reading = useRef(0)
  const olderReading = useRef(false)
  const list = held.task === task ? held.list : undefined
  const latest = useRef(list)
  latest.current = list

  const read = async ({ before }: { before?: number }) => {
    const receipt = await command({
      name: 'task',
      args: [
        'updates',
        task,
        '--limit',
        String(UPDATES_PAGE),
        ...before === undefined ? [] : [
          '--before',
          String(before),
        ],
      ],
    })

    return receipt as unknown as UpdatesRead
  }

  useEffect(
    () => {
      if (!connected) {
        return
      }

      const current = ++reading.current

      const readNewest = async () => {
        try {
          let page = await read({})
          const newestHeld = latest.current?.events[0]?.seq

          while (page.older !== undefined && newestHeld !== undefined
            && (page.events.at(-1)?.seq ?? 0) > newestHeld) {
            const before = page.older
            const older = await read({ before })

            if (reading.current !== current) {
              return
            }

            if (older.older !== undefined && older.older >= before) {
              throw new Error('The update history cursor did not advance')
            }

            page = {
              events: [
                ...page.events,
                ...older.events,
              ],
              older: older.older,
            }
          }

          if (reading.current !== current) {
            return
          }

          setHeld(before => ({
            task,
            list: withNewest({
              list: before.task === task ? before.list : undefined,
              read: page,
            }),
          }))
          setError(undefined)
        } catch (failure) {
          if (reading.current === current) {
            setError((failure as Error).message)
          }
        }

        if (reading.current === current) {
          setLoading(false)
        }
      }

      const timer = setTimeout(
        readNewest,
        latest.current ? REFRESH_MS : 0,
      )

      return () => clearTimeout(timer)
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
    loading: loading && !list,
    error,
    loadOlder: async () => {
      const before = latest.current?.older

      if (before === undefined || olderReading.current) {
        return
      }

      olderReading.current = true

      try {
        const page = await read({ before })
        setHeld(current => current.task === task && current.list?.older === before ? {
          task,
          list: withOlder({
            list: current.list,
            read: page,
          }),
        } : current)
      } catch (failure) {
        setError((failure as Error).message)
      } finally {
        olderReading.current = false
      }
    },
    retry: () => {
      setError(undefined)
      setLoading(true)
      setAttempt(count => count + 1)
    },
  }
}

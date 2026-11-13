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
  older(): void
  retry(): void
}

// A card's Updates, read from the server a page at a time: the newest page when the card opens and whenever the Hydra
// moves on, older pages as the list reaches its end.
export function useCardUpdates({
  task,
  command,
  connected,
  through,
}: {
  task: string
  command: Command
  connected: boolean
  // The Hydra's latest seq: a change in it may add an update.
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
      const timer = setTimeout(
        () => {
          read({}).then(page => {
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
            setLoading(false)
          })
            .catch((failure: Error) => {
              if (reading.current === current) {
                setError(failure.message)
                setLoading(false)
              }
            })
        },
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
    older: () => {
      const before = latest.current?.older

      if (before === undefined || olderReading.current) {
        return
      }

      olderReading.current = true
      read({ before }).then(page => {
        setHeld(current => current.task === task && current.list ? {
          task,
          list: withOlder({
            list: current.list,
            read: page,
          }),
        } : current)
      })
        .catch((failure: Error) => setError(failure.message))
        .finally(() => {
          olderReading.current = false
        })
    },
    retry: () => {
      setError(undefined)
      setLoading(true)
      setAttempt(count => count + 1)
    },
  }
}

import { useEffect, useRef, useState } from 'react'
import type { Hit } from '#oracle/index.ts'
import type { Command } from '#web-app/connection.ts'

// Typing waits this long before searching; a Hydra event refreshes the results at most this often.
export const SEARCH_DELAY = 180
export const REFRESH_DELAY = 2000

// Every search box ranks cards through the Hydra server's search, the same
// full-text ranking as `pnyx-axi oracle` and recorded history.
export const findCards = async ({
  command,
  query,
  workspace = '',
  live = false,
}: {
  command: Command
  query: string
  workspace?: string
  live?: boolean
}) => {
  const result = await command({
    name: 'oracle',
    args: [
      query,
      workspace,
      ...(live ? ['hydra'] : []),
    ],
  })

  return result.hits as Hit[]
}

export interface Search {
  text: string
  workspace: string
}

const keyOf = ({ search }: { search: Search }) => `${search.text}\n${search.workspace}`

// Events only refresh the shown query, so they never postpone a search; stale answers are dropped.
export function searchSchedule({
  find,
  show,
}: {
  find({ search }: { search: Search }): Promise<Hit[]>
  show({
    key,
    hits,
  }: {
    key: string
    hits: Hit[]
  }): void
}) {
  let current: Search | null = null
  let waiting: ReturnType<typeof setTimeout> | undefined
  let refreshing: ReturnType<typeof setTimeout> | undefined
  let running = false

  // Never rejects: a failed search leaves the last results in place, and the next query or event tries again.
  const send = async ({ search }: { search: Search }) => {
    running = true

    try {
      const hits = await find({ search })
      const stillCurrent = !!current && keyOf({ search: current }) === keyOf({ search })

      if (stillCurrent) {
        show({
          key: keyOf({ search }),
          hits,
        })
      }
    } catch {
      return
    } finally {
      running = false
    }
  }

  const refresh = () => {
    refreshing = undefined

    if (!current) {
      return
    }

    if (running) {
      changed()

      return
    }

    send({ search: current })
  }

  function changed() {
    if (!current || waiting || refreshing) {
      return
    }

    refreshing = setTimeout(
      refresh,
      REFRESH_DELAY,
    )
  }

  return {
    query({ search }: { search: Search | null }) {
      if (search && current && keyOf({ search }) === keyOf({ search: current })) {
        return
      }

      current = search
      clearTimeout(waiting); clearTimeout(refreshing)
      waiting = undefined; refreshing = undefined

      if (!search) {
        return
      }

      waiting = setTimeout(
        () => {
          waiting = undefined
          send({ search })
        },
        SEARCH_DELAY,
      )
    },
    changed,
    stop() {
      current = null
      clearTimeout(waiting); clearTimeout(refreshing)
    },
  }
}

// Keeps the last answered hits until the new query is answered, so the list never empties.
export function useFoundCards({
  command,
  query,
  workspace,
  revision,
}: {
  command: Command
  query: string
  workspace: string
  revision: number
}): {
  hits: Hit[]
  pending: boolean
} {
  const [
    found,
    setFound,
  ] = useState<{
    key: string
    hits: Hit[]
  } | null>(null)
  const text = query.trim()
  const search = text ? {
    text,
    workspace,
  } : null
  const key = search ? keyOf({ search }) : ''
  const latest = useRef(search); latest.current = search
  const schedule = useRef<ReturnType<typeof searchSchedule> | null>(null)
  useEffect(
    () => {
      const next = searchSchedule({
        find: ({ search }) => findCards({
          command,
          query: search.text,
          workspace: search.workspace,
          live: true,
        }),
        show: setFound,
      })
      schedule.current = next
      next.query({ search: latest.current })

      return () => next.stop()
    },
    [command],
  )
  useEffect(
    () => schedule.current?.query({ search: latest.current }),
    [key],
  )
  useEffect(
    () => schedule.current?.changed(),
    [revision],
  )

  const answered = !!search && !!found

  return {
    hits: answered ? found.hits : [],
    pending: !!search && found?.key !== key,
  }
}

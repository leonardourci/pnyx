import { useCallback, useEffect, useMemo, useState } from 'react'
import type { TitanSummary } from '#app/server-titans.ts'
import { TITAN_MARK } from '#titan/titan-names.ts'
import { CommandFailure } from '#web-shared/pending-intents.ts'
import type { Command } from './connection.ts'
import { inListOrder } from '#app/titan-list-order.ts'

type Edit = {
  name: string
  icon: string
}

const iconOf = ({ titan }: { titan: TitanSummary }) => titan.icon ?? TITAN_MARK

// A refused change goes back; one whose outcome is unknown may have been saved, so it keeps showing
// until the server's summary settles it.
const refused = ({ error }: { error: unknown }) => !(error instanceof CommandFailure && error.outcome === 'unknown')

const applied = ({
  titan,
  edit,
}: {
  titan: TitanSummary
  edit: Edit
}) => titan.name === edit.name && iconOf({ titan }) === edit.icon

// A Titan's new name, icon and place show at once in the panel and the header; the server's summary replaces them once it agrees.
export function useTitanEdits({
  titans,
  command,
  notify,
}: {
  titans: TitanSummary[]
  command: Command
  notify({ text }: { text: string }): void
}) {
  const [
    edits,
    setEdits,
  ] = useState<Record<string, Edit>>({})
  const [
    orders,
    setOrders,
  ] = useState<Record<string, number>>({})
  useEffect(
    () => {
      if (!Object.keys(orders).length) {
        return
      }

      setOrders(current => {
        const pending = Object.entries(current).filter(([
          id,
          order,
        ]) => titans.find(h => h.id === id)?.order !== order)

        if (pending.length === Object.keys(current).length) {
          return current
        }

        return Object.fromEntries(pending)
      })
    },
    [
      titans,
      orders,
    ],
  )
  useEffect(
    () => {
      if (!Object.keys(edits).length) {
        return
      }

      setEdits(current => {
        const pending = Object.entries(current).filter(([
          id,
          edit,
        ]) => {
          const titan = titans.find(h => h.id === id)

          return titan && !applied({
            titan,
            edit,
          })
        })

        if (pending.length === Object.keys(current).length) {
          return current
        }

        return Object.fromEntries(pending)
      })
    },
    [
      titans,
      edits,
    ],
  )

  // Only this edit goes back, never a newer one made since.
  const drop = ({
    id,
    edit,
  }: {
    id: string
    edit: Edit
  }) => setEdits(current => current[id]?.name === edit.name && current[id]?.icon === edit.icon
    ? Object.fromEntries(Object.entries(current).filter(([key]) => key !== id))
    : current)

  const edit = useCallback(
    async ({
      id,
      name,
      icon,
    }: Edit & { id: string }) => {
      const titan = titans.find(h => h.id === id)
      // Compared with what the panel shows, so changing a pending edit back still saves.
      const shownEdit = titan && (edits[id] ?? {
        name: titan.name,
        icon: iconOf({ titan }),
      })

      if (!shownEdit || (shownEdit.name === name && shownEdit.icon === icon)) {
        return
      }

      setEdits(current => ({
        ...current,
        [id]: {
          name,
          icon,
        },
      }))

      try {
        await command({
          name: 'titans',
          args: [
            'edit',
            id,
            name,
            icon,
          ],
        })
      } catch (error) {
        if (refused({ error })) {
          drop({
            id,
            edit: {
              name,
              icon,
            },
          })
        }

        notify({ text: (error as Error).message })
      }
    },
    [
      titans,
      edits,
      command,
      notify,
    ],
  )

  const move = useCallback(
    async ({
      id,
      position,
    }: {
      id: string
      position: number
    }) => {
      setOrders(current => ({
        ...current,
        [id]: position,
      }))

      try {
        await command({
          name: 'titans',
          args: [
            'move',
            id,
            String(position),
          ],
        })
      } catch (error) {
        if (refused({ error })) {
          setOrders(current => current[id] === position
            ? Object.fromEntries(Object.entries(current).filter(([key]) => key !== id))
            : current)
        }

        notify({ text: (error as Error).message })
      }
    },
    [
      command,
      notify,
    ],
  )

  // Kept stable while nothing changes, so effects that read the list don't run on every render.
  const shown = useMemo(
    () => {
      const named = titans.map(titan => {
        const pending = edits[titan.id]

        return pending ? {
          ...titan,
          ...pending,
        } : titan
      })

      if (!Object.keys(orders).length) {
        return named
      }

      return inListOrder({
        titans: named.map(titan => ({
          ...titan,
          order: orders[titan.id] ?? titan.order,
        })),
      })
    },
    [
      titans,
      edits,
      orders,
    ],
  )

  return useMemo(
    () => ({
      titans: shown,
      edit,
      move,
    }),
    [
      shown,
      edit,
      move,
    ],
  )
}

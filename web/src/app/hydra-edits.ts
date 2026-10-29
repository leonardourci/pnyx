import { useCallback, useEffect, useMemo, useState } from 'react'
import type { HydraSummary } from '#app/server-hydras.ts'
import { HYDRA_MARK } from '#hydra/hydra-names.ts'
import { CommandFailure } from '#web-shared/pending-intents.ts'
import type { Command } from './connection.ts'

type Edit = {
  name: string
  icon: string
}

const iconOf = ({ hydra }: { hydra: HydraSummary }) => hydra.icon ?? HYDRA_MARK

// A refused change goes back; one whose outcome is unknown may have been saved, so it keeps showing
// until the server's summary settles it.
const refused = ({ error }: { error: unknown }) => !(error instanceof CommandFailure && error.outcome === 'unknown')

const applied = ({
  hydra,
  edit,
}: {
  hydra: HydraSummary
  edit: Edit
}) => hydra.name === edit.name && iconOf({ hydra }) === edit.icon

// A Hydra's new name, icon and place show at once in the panel and the header; the server's summary replaces them once it agrees.
export function useHydraEdits({
  hydras,
  command,
  notify,
}: {
  hydras: HydraSummary[]
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
    () => setOrders(current => {
      const pending = Object.entries(current).filter(([
        id,
        order,
      ]) => hydras.find(h => h.id === id)?.order !== order)

      return pending.length === Object.keys(current).length ? current : Object.fromEntries(pending)
    }),
    [hydras],
  )
  useEffect(
    () => setEdits(current => {
      const pending = Object.entries(current).filter(([
        id,
        edit,
      ]) => {
        const hydra = hydras.find(h => h.id === id)

        return hydra && !applied({
          hydra,
          edit,
        })
      })

      return pending.length === Object.keys(current).length ? current : Object.fromEntries(pending)
    }),
    [hydras],
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
      const hydra = hydras.find(h => h.id === id)
      // Compared with what the panel shows, so changing a pending edit back still saves.
      const shownEdit = hydra && (edits[id] ?? {
        name: hydra.name,
        icon: iconOf({ hydra }),
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
          name: 'hydras',
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
      hydras,
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
          name: 'hydras',
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
      const named = hydras.map(hydra => {
        const pending = edits[hydra.id]

        return pending ? {
          ...hydra,
          ...pending,
        } : hydra
      })

      if (!Object.keys(orders).length) {
        return named
      }

      return named.map(hydra => ({
        ...hydra,
        order: orders[hydra.id] ?? hydra.order,
      })).sort((
        a,
        b,
      ) => a.order - b.order || a.id.localeCompare(b.id))
    },
    [
      hydras,
      edits,
      orders,
    ],
  )

  return {
    hydras: shown,
    edit,
    move,
  }
}

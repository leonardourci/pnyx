import { useCallback, useEffect, useMemo, useState } from 'react'
import type { HydraSummary } from '#app/server-hydras.ts'
import { HYDRA_MARK } from '#hydra/hydra-names.ts'
import type { Command } from './connection.ts'

type Edit = {
  name: string
  icon: string
}

const iconOf = ({ hydra }: { hydra: HydraSummary }) => hydra.icon ?? HYDRA_MARK

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

  const drop = ({ id }: { id: string }) => setEdits(current => Object.fromEntries(
    Object.entries(current).filter(([key]) => key !== id),
  ))

  const edit = useCallback(
    async ({
      id,
      name,
      icon,
    }: Edit & { id: string }) => {
      const hydra = hydras.find(h => h.id === id)

      if (!hydra || applied({
        hydra,
        edit: {
          name,
          icon,
        },
      })) {
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
            name === hydra.name ? '' : name,
            icon === iconOf({ hydra }) ? '' : icon,
          ],
        })
      } catch (error) {
        drop({ id })
        notify({ text: (error as Error).message })
      }
    },
    [
      hydras,
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
        setOrders(current => Object.fromEntries(
          Object.entries(current).filter(([key]) => key !== id),
        ))
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

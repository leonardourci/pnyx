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

// A Hydra's new name and icon show at once in the panel and the header; the server's summary replaces them once it agrees.
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
    ({
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
      void command({
        name: 'hydras',
        args: [
          'edit',
          id,
          name === hydra.name ? '' : name,
          icon === iconOf({ hydra }) ? '' : icon,
        ],
      }).catch((error: Error) => {
        drop({ id })
        notify({ text: error.message })
      })
    },
    [
      hydras,
      command,
      notify,
    ],
  )

  // Kept stable while nothing changes, so effects that read the list don't run on every render.
  const shown = useMemo(
    () => hydras.map(hydra => {
      const pending = edits[hydra.id]

      return pending ? {
        ...hydra,
        ...pending,
      } : hydra
    }),
    [
      hydras,
      edits,
    ],
  )

  return {
    hydras: shown,
    edit,
  }
}

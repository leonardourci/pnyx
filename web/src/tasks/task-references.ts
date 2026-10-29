import { useEffect, useMemo, useState } from 'react'
import type { HydraState } from '#app/model.ts'
import { hydraConfig } from '#hydra/config.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { cardState } from './view.ts'
import { statusLabel } from '#tasks/card-status.ts'
import type { DoneAfterHours } from '#settings/model.ts'
import { useSharedSettings } from '#web-settings/shared-settings.ts'

export function taskReferences({
  state,
  hours,
  now,
}: {
  state: HydraState
  hours?: DoneAfterHours
  now: number
}) {
  const config = hydraConfig({ state })

  return Object.fromEntries(Object.values(state.cards)
    .filter(c => c.id !== HYDRA_CARD && !c.automaticTask)
    .map(c => {
      const column = config.columns.find(column => column.id === c.column)
      const status = cardState({
        card: c,
        hours,
        now,
      })

      return [
        c.id,
        {
          title: c.title,
          state: statusLabel({ status }),
          kind: status.kind,
          column: column?.role ?? column?.id ?? 'custom',
        },
      ]
    }))
}

export function useTaskReferences({ state }: { state: HydraState }) {
  const [
    now,
    setNow,
  ] = useState(Date.now)
  useEffect(
    () => {
      const timer = setInterval(
        () => setNow(Date.now()),
        30_000,
      )

      return () => clearInterval(timer)
    },
    [],
  )

  const hours = useSharedSettings()?.doneAfterHours

  return useMemo(
    () => taskReferences({
      state,
      hours,
      now,
    }),
    [
      state.cards,
      state.config,
      hours,
      now,
    ],
  )
}

import type { CurrentAction } from '#hydra/calls.ts'
import { useEffect, useMemo, useState } from 'react'
import type { HydraState } from '#app/model.ts'
import { hydraConfig } from '#hydra/config.ts'
import { HYDRA_CARD } from '#hydra/identity.ts'
import { cardState } from './view.ts'
import { statusLabel } from '#tasks/card-status.ts'

export function taskReferences({
  state,
  now,
  actions,
  connected,
}: {
  state: HydraState
  actions?: Record<string, CurrentAction>
  connected?: boolean
  now: number
}) {
  const config = hydraConfig({ state })

  return Object.fromEntries(Object.values(state.cards)
    .filter(c => c.id !== HYDRA_CARD && !c.automaticTask)
    .map(c => {
      const column = config.columns.find(column => column.id === c.column)
      const status = cardState({
        card: c,
        state,
        action: actions?.[c.id],
        connected,
        hours: state.config?.doneAfterHours,
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

export function useTaskReferences({
  state,
  actions,
  connected,
}: {
  state: HydraState
  actions?: Record<string, CurrentAction>
  connected?: boolean
}) {
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

  return useMemo(
    () => taskReferences({
      state,
      actions,
      connected,
      now,
    }),
    [
      state.cards,
      connected,
      actions,
      state.config,
      now,
    ],
  )
}
